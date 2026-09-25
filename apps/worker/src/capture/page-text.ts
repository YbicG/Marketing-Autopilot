import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PageText } from "@mkt/core/runs";
import { assertPublicUrl, BlockedUrl } from "@mkt/core/security";

// One Chromium per proxy setting, shared by every capture in this process.
const browsers = new Map<string, Promise<Browser>>();

export async function getBrowser(proxyUrl?: string): Promise<Browser> {
  const key = proxyUrl ?? "";
  const existing = await browsers.get(key)?.catch(() => undefined);
  if (existing?.isConnected()) return existing;
  const launching = chromium.launch({
    // Keep WebRTC from leaking around the proxy; Smokescreen does the egress filtering (D8).
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
  });
  browsers.set(key, launching);
  launching.catch(() => browsers.delete(key));
  return launching;
}

export async function closeBrowser(): Promise<void> {
  const all = [...browsers.values()];
  browsers.clear();
  await Promise.all(all.map((p) => p.then((b) => b.close()).catch(() => undefined)));
}

/** true if the URL may be fetched. Results are cached per scheme+host unless `fresh` is set. */
export type UrlGuard = (url: string, opts?: { fresh?: boolean }) => Promise<boolean>;

export function createUrlGuard(selfIps: readonly string[]): UrlGuard {
  const cache = new Map<string, Promise<boolean>>();
  return (raw, opts = {}) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return Promise.resolve(false);
    }
    if (u.protocol === "data:" || u.protocol === "blob:") return Promise.resolve(true);
    const key = `${u.protocol}//${u.host}`;
    const cached = opts.fresh ? undefined : cache.get(key);
    if (cached) return cached;
    const check = assertPublicUrl(raw, { selfIps }).then(
      () => true,
      () => false,
    );
    cache.set(key, check);
    return check;
  };
}

/**
 * Route guard: GET/HEAD only; navigations (redirects included) get a fresh SSRF check, subresources
 * reuse the per-host result so an image-heavy page isn't one DNS lookup per request.
 */
export async function guardContext(context: BrowserContext, guard: UrlGuard): Promise<void> {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const ok =
      (req.method() === "GET" || req.method() === "HEAD") &&
      (await guard(req.url(), { fresh: req.isNavigationRequest() }));
    await (ok ? route.continue() : route.abort("blockedbyclient")).catch(() => undefined);
  });
}

/**
 * page.evaluate for a self-contained function. tsx/esbuild's keepNames wraps nested functions in
 * `__name(...)`, which doesn't exist in the page, so the source is shipped with a no-op shim.
 */
export async function runInPage<A, R>(page: Page, fn: (arg: A) => R, arg: A): Promise<Awaited<R>> {
  const src = `(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(arg) ?? "undefined"}); })()`;
  return (await page.evaluate(src)) as Awaited<R>;
}

/**
 * M0: the SSRF pre-check on the URL plus the route guard. Uses Smokescreen when SMOKESCREEN_URL is set.
 */
export async function fetchPageText(
  rawUrl: string,
  selfIps: readonly string[],
  proxyUrl: string | undefined = process.env.SMOKESCREEN_URL || undefined,
): Promise<PageText> {
  const { url } = await assertPublicUrl(rawUrl, { selfIps });
  const context = await (await getBrowser(proxyUrl)).newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  try {
    await guardContext(context, createUrlGuard(selfIps));
    const page = await context.newPage();
    const res = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!res) throw new BlockedUrl("That page didn't load.", "no_response");
    if (res.status() >= 400) throw new BlockedUrl(`That page returned an error (${res.status()}).`, "http_error");
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);

    const title = await page.title();
    const text = await page.evaluate(() => {
      for (const el of document.querySelectorAll("script,style,noscript,svg,iframe")) el.remove();
      return (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    });
    return { finalUrl: page.url(), title, text };
  } finally {
    await context.close().catch(() => undefined);
  }
}
