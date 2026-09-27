// Playwright capture for the landing audit (§5.4): the landing's first viewport on a phone
// (390×844) and a computer (1440×900) at DPR 2, with the redirect chain, load time, links,
// script hosts and meta tags. Same guard + proxy as captureSite (D8, SELF_IPS, Smokescreen).

import type { Browser, BrowserContext, Page, Request, Response } from "playwright";
import { assertPublicUrl } from "@mkt/core/security";
import { pngSize } from "../../capture/site.ts";
import { createUrlGuard, getBrowser, guardContext, runInPage, type UrlGuard } from "../../capture/page-text.ts";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const NAV_MS = 30_000;
const MAX_HTML = 1_000_000;

export interface CapturedViewport {
  text: string;
  buttons: { text: string; href?: string | null }[];
  png: Uint8Array | null;
  width: number;
  height: number;
}

export interface LandingCapture {
  requestedUrl: string;
  finalUrl: string;
  redirectChain: string[];
  status: number;
  loadMs: number;
  html: string;
  links: { href: string; text: string }[];
  scripts: string[];
  meta: Record<string, string>;
  desktop: CapturedViewport;
  mobile: CapturedViewport;
}

export type CaptureLanding = (url: string) => Promise<LandingCapture>;

interface PageFacts {
  text: string;
  buttons: { text: string; href: string | null }[];
  links: { href: string; text: string }[];
  scripts: string[];
  meta: Record<string, string>;
}

/** Runs in the page (self-contained): what's inside the first viewport, plus links/scripts/meta. */
export function firstViewportFacts(): PageFacts {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.top >= vh || r.bottom <= 0 || r.left >= vw || r.right <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const buttons: { text: string; href: string | null }[] = [];
  for (const el of Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]'))) {
    if (buttons.length >= 80) break;
    if (!shown(el)) continue;
    const h = el as HTMLElement;
    const text = clean(h.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || el.getAttribute("title"));
    if (text) buttons.push({ text, href: (el as HTMLAnchorElement).href || null });
  }
  const parts: string[] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let n = walker.nextNode(); n && total < 5_000; n = walker.nextNode()) {
    const t = clean(n.textContent);
    const parent = n.parentElement;
    if (!t || !parent || !shown(parent)) continue;
    parts.push(t);
    total += t.length;
  }
  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 300)
    .map((a) => ({ href: (a as HTMLAnchorElement).href, text: clean((a as HTMLElement).innerText || a.getAttribute("aria-label")) }))
    .filter((l) => /^https?:/i.test(l.href));
  const scripts = Array.from(new Set(Array.from(document.querySelectorAll("script[src]")).map((s) => {
    try {
      return new URL((s as HTMLScriptElement).src, location.href).hostname.toLowerCase();
    } catch {
      return "";
    }
  }))).filter(Boolean);
  const meta: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll("meta[content]"))) {
    const key = (m.getAttribute("property") || m.getAttribute("name") || "").toLowerCase();
    if (key && !(key in meta)) meta[key] = (m.getAttribute("content") ?? "").slice(0, 500);
  }
  return { text: parts.join(" ").slice(0, 5_000), buttons, links, scripts, meta };
}

async function newContext(browser: Browser, guard: UrlGuard, kind: "desktop" | "mobile"): Promise<BrowserContext> {
  const common = { deviceScaleFactor: 2, bypassCSP: true, serviceWorkers: "block" as const, acceptDownloads: false, locale: "en-US" };
  const context =
    kind === "desktop"
      ? await browser.newContext({
          ...common,
          viewport: DESKTOP,
          userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
        })
      : await browser.newContext({ ...common, viewport: MOBILE, userAgent: MOBILE_UA, isMobile: true, hasTouch: true });
  await guardContext(context, guard);
  return context;
}

/** Every URL the landing redirected to, in order (the first request itself excluded). */
function redirectChainOf(res: Response): string[] {
  const urls: string[] = [];
  for (let req: Request | null = res.request(); req; req = req.redirectedFrom()) urls.unshift(req.url());
  return urls.slice(1);
}

async function visit(context: BrowserContext, url: string, kind: "desktop" | "mobile") {
  const page: Page = await context.newPage();
  try {
    page.setDefaultTimeout(NAV_MS);
    const t0 = Date.now();
    const res = await page.goto(url, { waitUntil: "load", timeout: NAV_MS });
    const loadMs = Date.now() - t0;
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
    const facts = await runInPage(page, firstViewportFacts, undefined);
    const vp = kind === "desktop" ? DESKTOP : MOBILE;
    const png = await page
      .screenshot({ type: "png", clip: { x: 0, y: 0, width: vp.width, height: vp.height }, animations: "disabled", timeout: 15_000 })
      .catch(() => null);
    const size = png ? pngSize(png) : { width: 0, height: 0 };
    const html = kind === "desktop" ? (await page.content()).slice(0, MAX_HTML) : "";
    return {
      finalUrl: page.url(),
      status: res?.status() ?? 0,
      redirectChain: res ? redirectChainOf(res) : [],
      loadMs,
      html,
      facts,
      viewport: { text: facts.text, buttons: facts.buttons, png: png ? new Uint8Array(png) : null, width: size.width, height: size.height },
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Builds the capture used by landingAuditJob (run it under sem:heavy). */
export function playwrightLandingCapture(opts: { selfIps: readonly string[]; proxyUrl?: string }): CaptureLanding {
  return async (url) => {
    const { url: start } = await assertPublicUrl(url, { selfIps: opts.selfIps });
    const browser = await getBrowser(opts.proxyUrl);
    const guard = createUrlGuard(opts.selfIps);
    const contexts: BrowserContext[] = [];
    try {
      const desktopCtx = await newContext(browser, guard, "desktop");
      contexts.push(desktopCtx);
      const d = await visit(desktopCtx, start.href, "desktop");
      const mobileCtx = await newContext(browser, guard, "mobile");
      contexts.push(mobileCtx);
      const m = await visit(mobileCtx, start.href, "mobile");
      return {
        requestedUrl: start.href,
        finalUrl: d.finalUrl,
        // A redirect only phones get (m.example.com, /login on mobile) counts too.
        redirectChain: [...new Set([...d.redirectChain, ...m.redirectChain, ...(m.finalUrl !== d.finalUrl ? [m.finalUrl] : [])])],
        status: d.status,
        // The slower of the two first loads (phones are what launch traffic uses).
        loadMs: Math.max(d.loadMs, m.loadMs),
        html: d.html,
        links: d.facts.links,
        scripts: d.facts.scripts,
        meta: d.facts.meta,
        desktop: d.viewport,
        mobile: m.viewport,
      };
    } finally {
      await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    }
  };
}
