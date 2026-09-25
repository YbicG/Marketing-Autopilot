// M3b demo recorder (§5.6 step 1, D26). One Chromium per capture, pointed at the product's trusted
// internal origin ONLY:
// - the proxy is Smokescreen, bypassed for the trusted host alone; every other request is aborted by
//   the context.route guard (guard.ts) before it leaves, and WebRTC can't go around the proxy;
// - login runs in a separate context that is never recorded, and hands over only its storageState;
// - every click is re-checked against the action denylist on the element actually under the cursor;
// - page text is recorded for the personal-data scan and never read as instructions.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { CAPTURE_VIEWPORTS, type CaptureFlow, type CaptureFlowStep, type CaptureTarget, type CaptureViewport, type ClickLogEntry } from "@mkt/contracts";
import {
  boxCenter,
  buildClickLog,
  checkActionLabels,
  isAllowedRequest,
  validateTrustedOrigin,
  type RawPointerEvent,
  type RequestDecision,
} from "@mkt/core/capture";
import { runInPage } from "../page-text.ts";
import { frameEpochMs, toCfrFrames, wheelTicks, type CfrFrame, type ScreencastFrame } from "./timeline.ts";

export const CAPTURE_HEADER = "X-Mkt-Capture";
export const UA_SUFFIX = " MktCapture/1";
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const MOUSE_STEPS = 25;
const STEP_TIMEOUT_MS = 15_000;
const MAX_RECORDING_MS = 120_000;
const MAX_POINTER_EVENTS = 80_000;
const SCREEN_TEXT_CAP = 50_000;

/** Test login for the demo (purpose `capture.login.<productId>`). Never logged, never put in a prompt. */
export interface LoginSecret {
  username: string;
  password: string;
  /** Where the demo's login form lives; default /login. */
  loginPath?: string;
}
export type SecretResolver = (workspaceId: string, purpose: string) => Promise<LoginSecret | null>;

/** Implemented in @mkt/video/render (render-api.md); injected so this file doesn't pull in ffmpeg. */
export type FramesToCfr = (opts: { frames: CfrFrame[]; fps: 30; out: string }) => Promise<unknown>;

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Stopped on purpose (denylist, a bad origin, a failed login). Not retried. */
export class CaptureBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureBlocked";
  }
}

export interface RecordFlowOptions {
  origin: string;
  routeDenylist: readonly string[];
  flow: CaptureFlow;
  viewport: CaptureViewport;
  /** Smokescreen (SMOKESCREEN_URL). Required: capture never runs without the egress proxy. */
  proxyUrl: string;
  /** Resolved only when flow.needsLogin. */
  login: LoginSecret | null;
  framesToCfr: FramesToCfr;
  /** Scratch directory for frames and the mp4; the caller deletes it. */
  workDir: string;
}

export interface BlockedRequest {
  reason: Exclude<RequestDecision, { allow: true }>["reason"];
  detail?: string;
}

export interface RecordFlowResult {
  mp4Path: string;
  durationMs: number;
  width: number;
  height: number;
  clickLog: ClickLogEntry[];
  /** Visible page text after each step, for the personal-data scan. */
  screenTexts: string[];
  /** Frames with their time from the first frame (for the vision pass). */
  frames: { tMs: number; path: string }[];
  blocked: BlockedRequest[];
}

// ── In-page code (self-contained; see runInPage) ──

/** Every label of the element under the point and of its nearest clickable ancestor. */
function labelsAtPoint(p: { x: number; y: number }): string[] {
  const hit = document.elementFromPoint(p.x, p.y);
  if (!hit) return [];
  const clickable = hit.closest("button, a, [role=button], [role=link], [role=menuitem], [role=tab], input, label, summary, select, [onclick]") ?? hit;
  const out: string[] = [];
  for (const el of new Set([hit, clickable])) {
    const h = el as HTMLElement;
    out.push((h.innerText ?? "").slice(0, 300));
    for (const a of ["aria-label", "title", "value", "alt", "name", "id", "data-testid"]) out.push(el.getAttribute(a) ?? "");
    const lb = el.getAttribute("aria-labelledby");
    if (lb) for (const id of lb.split(/\s+/)) out.push(document.getElementById(id)?.textContent?.slice(0, 200) ?? "");
    for (const img of Array.from(el.querySelectorAll("img[alt], svg title")).slice(0, 5)) {
      out.push(img.getAttribute("alt") ?? img.textContent ?? "");
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) out.push(el.value ?? "");
  }
  return out.filter(Boolean);
}

/** Labels of the focused element and of its form's submit buttons (what Enter would press). */
function focusedFormLabels(): string[] {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return [];
  const out = [el.getAttribute("aria-label") ?? "", el.getAttribute("name") ?? ""];
  const form = el.closest("form");
  if (form) {
    out.push(form.getAttribute("action") ?? "", form.getAttribute("aria-label") ?? "");
    for (const b of Array.from(form.querySelectorAll("button, input[type=submit]")).slice(0, 10)) {
      out.push((b as HTMLElement).innerText ?? "", b.getAttribute("aria-label") ?? "", (b as HTMLInputElement).value ?? "");
    }
  }
  return out.filter(Boolean);
}

function screenText(cap: number): string {
  return (document.body?.innerText ?? "").slice(0, cap);
}

/**
 * Reports pointer events to the exposed binding. Looked up at call time so it doesn't depend on the
 * order Playwright installs bindings and init scripts. Runs in every document, so navigations are covered.
 */
const POINTER_LISTENER = `(() => {
  const send = (type, t, x, y) => {
    const f = globalThis.__mktPointer;
    if (typeof f !== "function") return;
    try { f({ type, t, x, y, vw: innerWidth, vh: innerHeight }); } catch {}
  };
  const at = (e) => performance.timeOrigin + e.timeStamp;
  let lx = innerWidth / 2, ly = innerHeight / 2;
  const opts = { capture: true, passive: true };
  addEventListener("mousemove", (e) => { lx = e.clientX; ly = e.clientY; send("move", at(e), lx, ly); }, opts);
  addEventListener("mousedown", (e) => send("click", at(e), e.clientX, e.clientY), opts);
  addEventListener("wheel", (e) => send("scroll", at(e), e.clientX, e.clientY), opts);
  addEventListener("scroll", (e) => send("scroll", at(e), lx, ly), opts);
})();`;

// ── Browser + contexts ──

async function launch(proxyUrl: string, host: string): Promise<Browser> {
  return chromium.launch({
    // WebRTC must not go around the proxy (D8).
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    // The trusted demo host is internal, so Smokescreen (which denies private ranges) is bypassed
    // for it and only it. Everything else the route guard aborts anyway.
    proxy: { server: proxyUrl, bypass: host },
  });
}

async function defaultUserAgent(browser: Browser): Promise<string> {
  // about:blank makes no requests; this context never navigates.
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    return await page.evaluate("navigator.userAgent");
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

function contextOptions(viewport: CaptureViewport, desktopUa: string, storageState?: StorageState): BrowserContextOptions {
  const size = CAPTURE_VIEWPORTS[viewport];
  const common: BrowserContextOptions = {
    viewport: size,
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
    locale: "en-US",
    extraHTTPHeaders: { [CAPTURE_HEADER]: "1" },
    ...(storageState ? { storageState } : {}),
  };
  return viewport === "mobile"
    ? { ...common, userAgent: MOBILE_UA + UA_SUFFIX, isMobile: true, hasTouch: true }
    : { ...common, userAgent: desktopUa.replace(/HeadlessChrome/g, "Chrome") + UA_SUFFIX };
}

async function guard(
  context: BrowserContext,
  origin: string,
  routeDenylist: readonly string[],
  blocked: BlockedRequest[],
): Promise<void> {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const d = isAllowedRequest({ url: req.url(), method: req.method(), trustedOrigin: origin, routeDenylist, resourceType: req.resourceType() });
    if (d.allow) {
      await route.continue().catch(() => undefined);
      return;
    }
    if (blocked.length < 1_000) blocked.push({ reason: d.reason, ...(d.detail ? { detail: d.detail } : {}) });
    await route.abort("blockedbyclient").catch(() => undefined);
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    const httpUrl = ws.url().replace(/^ws(s?):/i, "http$1:");
    const d = isAllowedRequest({ url: httpUrl, method: "GET", trustedOrigin: origin, routeDenylist, resourceType: "websocket" });
    if (d.allow) ws.connectToServer();
    else {
      if (blocked.length < 1_000) blocked.push({ reason: d.reason, detail: "websocket" });
      await ws.close().catch(() => undefined);
    }
  });
  // Popups and new tabs are closed; the flow stays on its one page.
  let first = true;
  context.on("page", (p) => {
    if (first) {
      first = false;
      p.on("dialog", (dlg) => void dlg.dismiss().catch(() => undefined));
      return;
    }
    void p.close().catch(() => undefined);
  });
}

function sameOriginUrl(origin: string, path: string): string {
  const u = new URL(path, origin);
  if (u.origin !== origin) throw new CaptureBlocked("A step tried to leave the demo site.");
  return u.href;
}

/** Separate, never-recorded context: log in, hand back only the session (storageState). */
async function loginState(browser: Browser, opts: RecordFlowOptions, desktopUa: string): Promise<StorageState> {
  const secret = opts.login;
  if (!secret) throw new CaptureBlocked("This flow needs the demo's test login. Add it in Settings.");
  const ctx = await browser.newContext(contextOptions(opts.viewport, desktopUa));
  const blocked: BlockedRequest[] = [];
  try {
    await guard(ctx, opts.origin, opts.routeDenylist, blocked);
    const page = await ctx.newPage();
    const loginUrl = sameOriginUrl(opts.origin, secret.loginPath ?? "/login");
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const user = page
      .locator("input[autocomplete=username], input[type=email], input[name=email], input[name=username], input[type=text]")
      .first();
    const pass = page.locator("input[type=password]").first();
    await user.fill(secret.username, { timeout: STEP_TIMEOUT_MS });
    await pass.fill(secret.password, { timeout: STEP_TIMEOUT_MS });
    await pass.press("Enter");
    const loginPath = new URL(loginUrl).pathname;
    await page.waitForURL((u) => u.pathname !== loginPath, { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    if (new URL(page.url()).pathname === loginPath && (await pass.isVisible().catch(() => false))) {
      throw new CaptureBlocked("The demo's test login didn't work. Check it in Settings.");
    }
    return await ctx.storageState();
  } catch (err) {
    // Playwright's messages can echo what was typed; never let the login leak into logs or lastError.
    if (err instanceof CaptureBlocked) throw err;
    throw new CaptureBlocked("Couldn't log in to the demo site. Check the test login and the login page address in Settings.");
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

function locate(page: Page, t: CaptureTarget) {
  switch (t.by) {
    case "text":
      return page.getByText(t.text).first();
    case "role":
      return page.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: t.name }).first();
    case "label":
      return page.getByLabel(t.label).first();
    case "placeholder":
      return page.getByPlaceholder(t.placeholder).first();
    case "selector":
      return page.locator(t.selector).first();
  }
}

/** Glide the cursor in 25 steps to the target's center; returns the point. */
async function moveTo(page: Page, t: CaptureTarget): Promise<{ x: number; y: number }> {
  const loc = locate(page, t);
  await loc.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await loc.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
  const box = await loc.boundingBox();
  if (!box) throw new Error("The element to click isn't on screen.");
  const p = boxCenter(box);
  await page.mouse.move(p.x, p.y, { steps: MOUSE_STEPS });
  return p;
}

/** Click-time check (§5.6): the element actually under the cursor, text + aria-label + title… */
async function assertClickable(page: Page, p: { x: number; y: number }): Promise<void> {
  const labels = await runInPage(page, labelsAtPoint, p);
  const check = checkActionLabels(labels);
  if (!check.allowed) throw new CaptureBlocked(`Stopped before clicking "${check.label}": "${check.word}" actions are never clicked in demos.`);
}

async function settle(page: Page, ms = 700): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function runStep(page: Page, step: CaptureFlowStep, origin: string): Promise<void> {
  switch (step.kind) {
    case "goto":
      await page.goto(sameOriginUrl(origin, step.path), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return;
    case "click": {
      const p = await moveTo(page, step.target);
      await assertClickable(page, p);
      await page.mouse.click(p.x, p.y, { delay: 60 });
      return;
    }
    case "hover":
      await moveTo(page, step.target);
      return;
    case "type": {
      const p = await moveTo(page, step.field);
      await assertClickable(page, p);
      await page.mouse.click(p.x, p.y, { delay: 40 });
      await page.keyboard.type(step.text, { delay: 55 });
      return;
    }
    case "scroll":
      for (const dy of wheelTicks(step.amountPx, step.direction)) {
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(35);
      }
      return;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
    case "pressKey": {
      if (step.key === "Enter" || step.key === "Space") {
        const check = checkActionLabels(await runInPage(page, focusedFormLabels, undefined));
        if (!check.allowed) throw new CaptureBlocked(`Stopped before pressing ${step.key}: it would trigger "${check.label}".`);
      }
      await page.keyboard.press(step.key === "Space" ? " " : step.key);
      return;
    }
  }
}

/** Record one flow: frames + click log → 30 fps CFR mp4 (framesToCfr). */
export async function recordFlow(opts: RecordFlowOptions): Promise<RecordFlowResult> {
  const trusted = validateTrustedOrigin(opts.origin);
  if (!trusted.ok) throw new CaptureBlocked(trusted.reason);
  if (!opts.proxyUrl) throw new CaptureBlocked("Recording needs the egress proxy (SMOKESCREEN_URL), and it isn't set.");
  const origin = trusted.origin;
  const size = CAPTURE_VIEWPORTS[opts.viewport];
  const framesDir = join(opts.workDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const browser = await launch(opts.proxyUrl, trusted.host);
  const blocked: BlockedRequest[] = [];
  try {
    const desktopUa = await defaultUserAgent(browser);
    const storageState = opts.flow.needsLogin ? await loginState(browser, { ...opts, origin }, desktopUa) : undefined;

    const context = await browser.newContext(contextOptions(opts.viewport, desktopUa, storageState));
    await guard(context, origin, opts.routeDenylist, blocked);
    const pointer: RawPointerEvent[] = [];
    await context.exposeBinding("__mktPointer", (_src, ev: RawPointerEvent) => {
      if (pointer.length < MAX_POINTER_EVENTS) pointer.push(ev);
    });
    await context.addInitScript(POINTER_LISTENER);

    const page = await context.newPage();
    const [first, ...rest] = opts.flow.steps;
    const startPath = first?.kind === "goto" ? first.path : "/";
    await page.goto(sameOriginUrl(origin, startPath), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settle(page, 300);
    await page.mouse.move(size.width / 2, size.height / 2);

    // Screencast over CDP: JPEG per repaint, each acked, with the compositor's timestamp.
    const cdp = await context.newCDPSession(page);
    const frames: ScreencastFrame[] = [];
    const writes: Promise<void>[] = [];
    cdp.on("Page.screencastFrame", (ev) => {
      const path = join(framesDir, `f${String(frames.length).padStart(6, "0")}.jpg`);
      frames.push({ path, epochMs: frameEpochMs(ev.metadata.timestamp, Date.now()) });
      writes.push(writeFile(path, Buffer.from(ev.data, "base64")));
      void cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 85,
      maxWidth: size.width,
      maxHeight: size.height,
      everyNthFrame: 1,
    });

    const screenTexts: string[] = [];
    const started = Date.now();
    await page.waitForTimeout(800);
    screenTexts.push(await runInPage(page, screenText, SCREEN_TEXT_CAP).catch(() => ""));
    for (const step of first?.kind === "goto" ? rest : opts.flow.steps) {
      if (Date.now() - started > MAX_RECORDING_MS) throw new CaptureBlocked("The flow ran longer than 2 minutes. Shorten it and try again.");
      await runStep(page, step, origin);
      await settle(page);
      screenTexts.push(await runInPage(page, screenText, SCREEN_TEXT_CAP).catch(() => ""));
    }
    await page.waitForTimeout(1_200);
    const stopEpochMs = Date.now();
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await Promise.all(writes);
    await context.close().catch(() => undefined);

    if (frames.length === 0) throw new Error("The recording captured no frames.");
    const cfr = toCfrFrames(frames, stopEpochMs);
    const mp4Path = join(opts.workDir, "recording.mp4");
    await opts.framesToCfr({ frames: cfr.frames, fps: 30, out: mp4Path });
    return {
      mp4Path,
      durationMs: cfr.durationMs,
      width: size.width,
      height: size.height,
      clickLog: buildClickLog(pointer, cfr.t0EpochMs, stopEpochMs),
      screenTexts,
      frames: cfr.frames.map((f) => ({ tMs: f.timestampMs, path: f.path })),
      blocked,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
