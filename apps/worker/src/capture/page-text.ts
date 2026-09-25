import { chromium, type Browser } from "playwright";
import type { PageText } from "@mkt/core/runs";
import { assertPublicUrl, BlockedUrl } from "@mkt/core/security";

let browser: Browser | undefined;

async function getBrowser(): Promise<Browser> {
  if (!browser?.isConnected()) {
    browser = await chromium.launch({
      // Keep WebRTC from leaking around any proxy; Smokescreen egress arrives in M1 (D8).
      args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => undefined);
  browser = undefined;
}

/**
 * M0: the SSRF pre-check on the URL and on every document navigation (redirects included).
 * M1 replaces this with the full safe-fetch + Smokescreen path.
 */
export async function fetchPageText(rawUrl: string, selfIps: readonly string[]): Promise<PageText> {
  const { url } = await assertPublicUrl(rawUrl, { selfIps });
  const context = await (await getBrowser()).newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: undefined,
    javaScriptEnabled: true,
  });
  try {
    await context.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() !== "GET" && req.method() !== "HEAD") return route.abort("blockedbyclient");
      if (req.isNavigationRequest()) {
        try {
          await assertPublicUrl(req.url(), { selfIps });
        } catch {
          return route.abort("blockedbyclient");
        }
      }
      return route.continue();
    });
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
