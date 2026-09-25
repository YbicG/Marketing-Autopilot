import type { Browser, BrowserContext, Page } from "playwright";
import type { BrandTokens, CapturedPage, CapturedScreenshot, SiteCapture } from "@mkt/core/ingest";
import { assertPublicUrl, BlockedUrl } from "@mkt/core/security";
import { domToMarkdown } from "./dom-markdown.ts";
import { clickConsent, collectBrand, pageHeight, scrollForLazyImages, type BrandSample } from "./page-scripts.ts";
import { createUrlGuard, getBrowser, guardContext, runInPage, type UrlGuard } from "./page-text.ts";

const MAX_PAGES = 25;
const DESKTOP_SHOTS = 6;
const PAGE_MD_CAP = 30_000;
const TOTAL_MD_CAP = 200_000;
const DEADLINE_MS = 150_000;
const PAGE_MS = 25_000;
/** Mobile shots run last; keep this much of the deadline for them. */
const MOBILE_RESERVE_MS = 30_000;
/** 3900 CSS px at DPR 2 = 7800 px, under the vision API's 8000 px edge limit. */
const MAX_SHOT_CSS_PX = 3900;
const CONCURRENCY = 3;
const MAX_SITEMAP_BYTES = 5_000_000;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

const CHAT_WIDGET_CSS = `
#intercom-container, #intercom-frame, .intercom-lightweight-app, .intercom-launcher, .intercom-messenger-frame,
#crisp-chatbox, .crisp-client, #drift-widget, #drift-frame-controller, #drift-frame-chat, .drift-frame-controller,
#hubspot-messages-iframe-container, .hs-messages-widget-open, [id^="tawk-"], .tawk-min-container,
iframe[title*="chat widget" i], iframe#launcher, #launcher[title], #webWidget, .zEWidget-launcher,
[data-testid="launcher"], iframe[title*="Messaging window" i], iframe[title*="Button to launch messaging" i]
{ display: none !important; visibility: hidden !important; }`;

const CONSENT_CSS = `
#onetrust-consent-sdk, #onetrust-banner-sdk, #CybotCookiebotDialog, #usercentrics-root, #didomi-host,
.qc-cmp2-container, #truste-consent-track, .osano-cm-window, #cookiefirst-root, .cky-consent-container,
.cc-window, .cc-banner, #cookie-banner, #cookie-notice, #cookie-consent, #cookieConsent, .cookie-banner,
.cookie-notice, .cookie-consent, .cookies-banner, [id^="sp_message_container"], [class*="CookieBanner"],
[id*="cookie-banner"], [class*="cookie-banner"], [id*="cookieconsent"], [class*="cookieconsent"],
[aria-label*="cookie" i][role="dialog"], [aria-label*="cookie" i][role="region"]
{ display: none !important; }`;

// Chat widgets load late, so the CSS goes in on every document of the context.
const CHAT_WIDGET_INIT = `(() => {
  const add = () => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(CHAT_WIDGET_CSS)};
    (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();`;

// ── Pure helpers (unit-tested) ──

const TRACKING_PARAMS = /^(utm_\w+|gclid|gbraid|wbraid|fbclid|msclkid|yclid|dclid|igshid|mc_cid|mc_eid|_ga|_gl|_hsenc|_hsmi|ref|ref_src|source)$/i;
const HTML_EXT = /\.(html?|php|aspx?|jsp|shtml)$/i;

/** Absolute http(s) URL without hash, tracking params or trailing slash; null if unusable. */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.href.replace(/\?$/, "");
}

/** Links to files (PDFs, images, archives, installers, feeds...) are not pages. */
export function isLikelyHtmlUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const last = path.split("/").pop() ?? "";
  if (!last.includes(".")) return true;
  return HTML_EXT.test(last);
}

const PRIORITY: readonly (readonly string[])[] = [
  ["pricing", "plans", "price", "prices"],
  ["features", "feature"],
  ["product", "products", "platform", "solutions", "tour"],
  ["how-it-works", "how-it-work", "howitworks"],
  ["about", "about-us", "company"],
  ["faq", "faqs"],
  ["download", "downloads", "install", "get-started"],
  ["changelog", "releases", "release-notes", "whats-new", "updates"],
  ["docs", "documentation", "guide", "guides", "help"],
];
const LOW = new Set([
  "blog", "posts", "post", "news", "articles", "article", "press", "legal", "privacy", "privacy-policy",
  "terms", "terms-of-service", "terms-and-conditions", "tos", "cookies", "cookie-policy", "gdpr", "dpa",
  "imprint", "impressum", "careers", "jobs", "login", "log-in", "signin", "sign-in", "signup", "sign-up",
  "register", "auth", "account", "tag", "tags", "category", "categories", "author", "authors",
]);
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z]{2})?$/i;

function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return strip(a) === strip(b);
}

/**
 * Same-site page URLs, deduped and ranked (lower is more important): home 0, then the product
 * pages in PRIORITY order, then everything else, with blog/legal/careers/auth last. Deeper paths
 * rank slightly lower within their group.
 */
export function rankPaths(urls: readonly string[], origin: string): { url: string; rank: number }[] {
  const base = new URL(origin);
  const seen = new Map<string, { url: string; rank: number; order: number }>();
  urls.forEach((raw, order) => {
    const norm = normalizeUrl(raw, base.href);
    if (!norm) return;
    const u = new URL(norm);
    if (!sameSite(u.hostname, base.hostname) || !isLikelyHtmlUrl(norm)) return;
    // www/apex and http/https variants are the same page: rewrite onto the site's own origin.
    u.protocol = base.protocol;
    u.host = base.host;
    const url = normalizeUrl(u.href)!;
    if (seen.has(url)) return;
    seen.set(url, { url, rank: pathRank(u), order });
  });
  return [...seen.values()]
    .sort((a, b) => a.rank - b.rank || a.url.length - b.url.length || a.order - b.order)
    .map(({ url, rank }) => ({ url, rank }));
}

function pathRank(u: URL): number {
  let segs = u.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
  if (segs.length > 0 && LOCALE_SEGMENT.test(segs[0]!)) segs = segs.slice(1);
  if (segs.length === 0) return u.search ? 1 : 0;
  const depth = Math.min(segs.length - 1, 9);
  if (segs.slice(0, 2).some((s) => LOW.has(s))) return 200 + depth;
  for (const s of segs.slice(0, 2)) {
    const i = PRIORITY.findIndex((group) => group.includes(s));
    if (i >= 0) return (i + 1) * 10 + depth;
  }
  return 100 + depth;
}

/** <loc> entries of a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
  return /<sitemapindex[\s>]/i.test(xml) ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

/** "rgb(…)", "rgba(…)", "rgb(r g b / a)" or "#rgb[a]"/"#rrggbb[aa]" → "#rrggbb"; null when mostly transparent. */
export function cssColorToHex(css: string): string | null {
  const s = css.trim().toLowerCase();
  let r: number, g: number, b: number, a = 1;
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (fn) {
    [r, g, b] = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
    if (fn[4] !== undefined) a = Number(fn[4]) / (fn[5] ? 100 : 1);
  } else if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else {
    return null;
  }
  if (a < 0.5 || [r, g, b].some((v) => !Number.isFinite(v))) return null;
  const to2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** Grays, black and white carry no brand signal. */
export function isGray(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
}

export type ColorSample = readonly [css: string, weight: number];

/**
 * Most-used non-gray colors. Each group is normalized to the same total first so large background
 * areas don't drown out text and buttons; buttons count extra because that's where brand color lives.
 */
export function brandColors(
  groups: { background: readonly ColorSample[]; text: readonly ColorSample[]; button: readonly ColorSample[] },
  limit = 6,
): string[] {
  const score = new Map<string, number>();
  const add = (samples: readonly ColorSample[], groupWeight: number) => {
    const tally = new Map<string, number>();
    for (const [css, w] of samples) {
      const hex = cssColorToHex(css);
      if (!hex || isGray(hex) || !(w > 0)) continue;
      tally.set(hex, (tally.get(hex) ?? 0) + w);
    }
    const total = [...tally.values()].reduce((s, v) => s + v, 0);
    for (const [hex, w] of tally) score.set(hex, (score.get(hex) ?? 0) + (w / total) * groupWeight);
  };
  add(groups.button, 1.5);
  add(groups.background, 1);
  add(groups.text, 0.75);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([hex]) => hex);
}

const GENERIC_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif",
  "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "emoji", "math", "fangsong",
  "inherit", "initial", "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji",
]);

/** First real family of each font-family stack, deduped. next/font's "__Inter_d65c78" becomes "Inter". */
export function parseFontFamilies(stacks: readonly string[], limit = 4): string[] {
  const out: string[] = [];
  for (const stack of stacks) {
    for (const part of stack.split(",")) {
      let name = part.trim().replace(/^["']|["']$/g, "").trim();
      if (!name || GENERIC_FONTS.has(name.toLowerCase()) || /fallback/i.test(name)) continue;
      const next = /^__(.+?)_[0-9a-f]{5,8}$/i.exec(name);
      if (next) name = next[1]!.replace(/_/g, " ");
      if (!out.some((f) => f.toLowerCase() === name.toLowerCase())) out.push(name);
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

const GITHUB_NON_OWNERS = new Set([
  "about", "features", "pricing", "sponsors", "orgs", "settings", "marketplace", "topics", "login", "join",
  "signup", "explore", "collections", "trending", "events", "enterprise", "security", "site", "contact",
  "customer-stories", "readme", "apps", "notifications", "new", "organizations", "search", "team", "home",
]);

/** The github.com/<owner>/<repo> linked most often (first seen wins ties). */
export function githubRepoFromLinks(hrefs: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const href of hrefs) {
    const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:[/?#]|$)/i.exec(href);
    if (!m || GITHUB_NON_OWNERS.has(m[1]!.toLowerCase())) continue;
    const repo = m[2]!.replace(/\.git$/i, "");
    if (!repo || repo === "." || repo === "..") continue;
    const key = `https://github.com/${m[1]}/${repo}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount) [best, bestCount] = [key, n];
  }
  return best;
}

/** Pixel size from a PNG's IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || sig.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// ── Capture ──

interface CaptureOpts {
  selfIps: readonly string[];
  proxyUrl?: string;
}

/**
 * Website capture for ingest (§5.2 step 2): up to 25 ranked pages as markdown, full-page shots of
 * the top pages (desktop) and home + pricing (mobile), brand tokens and meta from the home page.
 * Every request goes through the route guard (and Smokescreen when proxyUrl is set).
 */
export async function captureSite(url: string, opts: CaptureOpts): Promise<SiteCapture> {
  const deadline = Date.now() + DEADLINE_MS;
  const left = () => deadline - Date.now();
  const { url: start } = await assertPublicUrl(url, { selfIps: opts.selfIps });
  const browser = await getBrowser(opts.proxyUrl);
  const guard = createUrlGuard(opts.selfIps);
  const contexts: BrowserContext[] = [];
  try {
    const desktop = await newContext(browser, guard, "desktop");
    contexts.push(desktop);

    // Home: markdown, brand, meta and the first screenshot. Failure here fails the capture.
    let home: { finalUrl: string; title: string; markdown: string; brand: BrandSample; shot: CapturedScreenshot | null };
    try {
      home = await withPage(desktop, start.href, Math.min(PAGE_MS + 10_000, left()), async (page) => ({
        finalUrl: page.url(),
        title: await page.title(),
        markdown: await runInPage(page, domToMarkdown, PAGE_MD_CAP),
        brand: await runInPage(page, collectBrand, undefined),
        shot: await shoot(page, "desktop").catch(() => null),
      }));
    } catch (err) {
      throw homeFailure(err);
    }
    const origin = new URL(home.finalUrl).origin;

    const sitemapUrls = await readSitemap(desktop, origin, guard, Math.min(12_000, left())).catch(() => []);
    const homeKey = normalizeUrl(home.finalUrl);
    const rest = rankPaths([...home.brand.links, ...sitemapUrls], origin)
      .filter((r) => r.url !== homeKey)
      .slice(0, MAX_PAGES - 1);

    // Other pages, a few at a time; a page that fails or runs out of time is skipped.
    type Visited = { url: string; title: string; markdown: string; rank: number; shot: CapturedScreenshot | null };
    const visited: (Visited | undefined)[] = [];
    let next = 0;
    const lane = async () => {
      while (next < rest.length) {
        const i = next++;
        const item = rest[i]!;
        const budget = Math.min(PAGE_MS, left() - MOBILE_RESERVE_MS);
        if (budget < 5_000) return;
        visited[i] = await withPage(desktop, item.url, budget, async (page) => ({
          url: page.url(),
          title: await page.title(),
          markdown: await runInPage(page, domToMarkdown, PAGE_MD_CAP),
          rank: item.rank,
          shot: i < DESKTOP_SHOTS - 1 ? await shoot(page, "desktop").catch(() => null) : null,
        })).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, lane));

    const pages: CapturedPage[] = [];
    const screenshots: CapturedScreenshot[] = [];
    const seen = new Set<string>();
    let mdTotal = 0;
    for (const p of [{ ...home, url: home.finalUrl, rank: 0 }, ...visited]) {
      if (!p) continue;
      const key = normalizeUrl(p.url) ?? p.url;
      if (seen.has(key)) continue; // two links that redirect to the same page
      seen.add(key);
      if (p.shot) screenshots.push(p.shot);
      if (mdTotal >= TOTAL_MD_CAP) continue;
      const markdown = p.markdown.slice(0, TOTAL_MD_CAP - mdTotal);
      mdTotal += markdown.length;
      pages.push({ url: p.url, title: p.title, markdown, rank: p.rank });
    }

    // Mobile: home + pricing.
    const pricing = rest.find((r) => /\/(pricing|plans)(\/|$)/i.test(new URL(r.url).pathname));
    const mobileTargets = [home.finalUrl, ...(pricing ? [pricing.url] : [])];
    if (left() > 5_000) {
      const mobile = await newContext(browser, guard, "mobile");
      contexts.push(mobile);
      for (const target of mobileTargets) {
        const budget = Math.min(PAGE_MS, left());
        if (budget < 5_000) break;
        const shot = await withPage(mobile, target, budget, (page) => shoot(page, "mobile")).catch(() => null);
        if (shot) screenshots.push(shot);
      }
    }

    const b = home.brand;
    const brand: BrandTokens = {
      colors: brandColors(b),
      fonts: parseFontFamilies(b.fontStacks),
      logoUrl: b.logoUrl,
      themeColor: b.themeColor ? cssColorToHex(b.themeColor) : null,
    };
    return {
      finalUrl: home.finalUrl,
      pages,
      screenshots,
      brand,
      meta: { description: b.description, ogImage: b.ogImage, githubUrl: githubRepoFromLinks(b.links) },
    };
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
  }
}

async function newContext(browser: Browser, guard: UrlGuard, kind: "desktop" | "mobile"): Promise<BrowserContext> {
  const common = {
    deviceScaleFactor: 2,
    // Needed so the injected hide-CSS and page scripts work on sites with a strict CSP.
    bypassCSP: true,
    serviceWorkers: "block" as const,
    acceptDownloads: false,
    locale: "en-US",
  };
  const context =
    kind === "desktop"
      ? await browser.newContext({
          ...common,
          viewport: DESKTOP,
          // Headless Chromium says "HeadlessChrome", which some sites refuse; this is the same browser.
          userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
        })
      : await browser.newContext({ ...common, viewport: MOBILE, userAgent: MOBILE_UA, isMobile: true, hasTouch: true });
  await context.addInitScript(CHAT_WIDGET_INIT);
  await guardContext(context, guard);
  return context;
}

/**
 * Opens a page, settles it and runs `fn`. The page is closed when the budget runs out, which
 * rejects whatever `fn` is waiting on.
 */
async function withPage<T>(context: BrowserContext, url: string, budgetMs: number, fn: (page: Page) => Promise<T>): Promise<T> {
  if (budgetMs <= 0) throw new Error("timeout");
  const page = await context.newPage();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void page.close().catch(() => undefined);
  }, budgetMs);
  try {
    page.setDefaultTimeout(budgetMs);
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: budgetMs });
    if (!res) throw new Error("no_response");
    if (res.status() >= 400) throw new Error(`http_${res.status()}`);
    const type = (await res.headerValue("content-type")) ?? "";
    if (type && !/html/i.test(type)) throw new Error("not_html");
    await settle(page);
    return await fn(page);
  } catch (err) {
    throw timedOut ? new Error("timeout") : err;
  } finally {
    clearTimeout(timer);
    await page.close().catch(() => undefined);
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  // Click first (the choice is what actually removes a banner), then hide whatever is left.
  const clicked = await runInPage(page, clickConsent, undefined).catch(() => false);
  if (clicked) {
    await page.waitForTimeout(600); // some CMPs reload the page after a choice
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  }
  await page.addStyleTag({ content: CONSENT_CSS }).catch(() => undefined);
  await runInPage(page, scrollForLazyImages, MAX_SHOT_CSS_PX).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
}

async function shoot(page: Page, viewport: "desktop" | "mobile"): Promise<CapturedScreenshot> {
  const vp = viewport === "desktop" ? DESKTOP : MOBILE;
  const height = Math.min(await runInPage(page, pageHeight, undefined), MAX_SHOT_CSS_PX);
  const png = await page.screenshot({
    type: "png",
    fullPage: true,
    clip: { x: 0, y: 0, width: vp.width, height },
    animations: "disabled",
    timeout: 15_000,
  });
  // Vision labeling gets the first viewport at DPR 1; full pages can exceed the image limits.
  const preview = await page.screenshot({
    type: "jpeg",
    quality: 70,
    scale: "css",
    clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, height) },
    animations: "disabled",
    timeout: 10_000,
  });
  const size = pngSize(png);
  return { pageUrl: page.url(), viewport, png, preview, width: size.width, height: size.height };
}

/** GET through the context's request API (same proxy as the browser), redirects re-checked by hand. */
async function guardedGet(context: BrowserContext, url: string, guard: UrlGuard, timeoutMs: number): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    if (!(await guard(current, { fresh: true }))) return null;
    const res = await context.request.get(current, { maxRedirects: 0, timeout: timeoutMs, failOnStatusCode: false });
    try {
      const status = res.status();
      if (status >= 300 && status < 400) {
        const location = res.headers()["location"];
        if (!location) return null;
        current = new URL(location, current).href;
        continue;
      }
      if (!res.ok() || Number(res.headers()["content-length"] ?? 0) > MAX_SITEMAP_BYTES) return null;
      const body = await res.body();
      return body.length > MAX_SITEMAP_BYTES ? null : body.toString("utf8");
    } finally {
      await res.dispose().catch(() => undefined);
    }
  }
  return null;
}

/** /sitemap.xml (or the Sitemap: lines in robots.txt), following up to 3 child sitemaps of an index. */
async function readSitemap(context: BrowserContext, origin: string, guard: UrlGuard, budgetMs: number): Promise<string[]> {
  const until = Date.now() + budgetMs;
  const remaining = () => Math.max(1_000, until - Date.now());
  const roots = [`${origin}/sitemap.xml`];
  const robots = await guardedGet(context, `${origin}/robots.txt`, guard, remaining()).catch(() => null);
  for (const m of robots?.matchAll(/^\s*sitemap:\s*(\S+)/gim) ?? []) {
    if (!roots.includes(m[1]!)) roots.push(m[1]!);
  }
  const urls: string[] = [];
  const queue = roots.slice(0, 3);
  let fetched = 0;
  while (queue.length > 0 && fetched < 6 && Date.now() < until && urls.length < 5_000) {
    const sm = queue.shift()!;
    if (/\.gz$/i.test(sm)) continue;
    fetched++;
    const xml = await guardedGet(context, sm, guard, remaining()).catch(() => null);
    if (!xml) continue;
    const parsed = parseSitemap(xml);
    urls.push(...parsed.urls);
    // Page-ish child sitemaps first; post/tag sitemaps are mostly blog.
    const children = parsed.sitemaps.sort((a, b) => Number(/post|tag|categor|author|blog/i.test(a)) - Number(/post|tag|categor|author|blog/i.test(b)));
    queue.push(...children.slice(0, 3));
  }
  return urls.slice(0, 5_000);
}

function homeFailure(err: unknown): BlockedUrl {
  if (err instanceof BlockedUrl) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const http = /^http_(\d{3})$/.exec(msg);
  if (http) return new BlockedUrl(`That website returned an error (${http[1]}).`, "http_error");
  if (msg === "not_html") return new BlockedUrl("That link isn't a web page.", "not_html");
  if (msg === "timeout" || /Timeout/i.test(msg)) return new BlockedUrl("That website took too long to load.", "timeout");
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return new BlockedUrl("We couldn't find that website. Check the address.", "dns");
  if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(msg)) {
    return new BlockedUrl("That website sent us somewhere we're not allowed to go.", "blocked_redirect");
  }
  if (/ERR_CERT|SSL/.test(msg)) return new BlockedUrl("That website's security certificate isn't valid.", "tls");
  return new BlockedUrl("We couldn't open that website. Check the address and try again.", "home_failed");
}
