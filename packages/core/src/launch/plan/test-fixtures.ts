// Test-only: landing snapshots for the audit analyzers (imported by *.test.ts).
import type { LandingSnapshot } from "./audit.ts";

const SENT = { utm_source: "test", utm_medium: "organic", utm_campaign: "launch-check", utm_content: "mkt-audit-abc", utm_term: "probe" };
const withSent = (base: string) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(SENT)) u.searchParams.set(k, v);
  return u.href;
};

/** A landing page that passes every check. */
export function goodSnapshot(over: Partial<LandingSnapshot> = {}): LandingSnapshot {
  return {
    requestedUrl: "https://syllacal.com/",
    finalUrl: "https://syllacal.com/",
    redirectChain: [],
    status: 200,
    loadMs: 1_400,
    html: `<html><head><title>SyllaCal</title><meta name="description" content="Your syllabus, now a calendar"></head>
      <body><h1>Your syllabus, now a calendar</h1><a href="/start">Try it free</a><p>One-time price: $9.99</p>
      <script>navigator.sendBeacon("/api/marketing/pv")</script></body></html>`,
    desktop: { text: "Your syllabus, now a calendar Try it free", buttons: [{ text: "Try it free", href: "https://syllacal.com/start" }], screenshotAssetId: "shot-d" },
    mobile: { text: "Your syllabus, now a calendar Try it free", buttons: [{ text: "Try it free", href: "https://syllacal.com/start" }], screenshotAssetId: "shot-m" },
    links: [
      { href: "https://syllacal.com/start", text: "Try it free" },
      { href: "https://syllacal.com/faq", text: "FAQ" },
    ],
    scripts: ["syllacal.com"],
    meta: { "og:title": "SyllaCal", "og:image": "https://syllacal.com/og.png", description: "Your syllabus, now a calendar" },
    trackingProbe: { sentParams: SENT, finalUrl: withSent("https://syllacal.com/"), redirectChain: [] },
    ...over,
  };
}

/** Redirects every visitor to a login page. */
export function signupWallSnapshot(): LandingSnapshot {
  return goodSnapshot({
    redirectChain: ["https://syllacal.com/login?next=%2F"],
    finalUrl: "https://syllacal.com/login?next=%2F",
    html: `<html><body><form><input type="email"><input type="password"><button>Log in</button></form></body></html>`,
    desktop: { text: "Log in", buttons: [{ text: "Log in" }], screenshotAssetId: "shot-d" },
    mobile: { text: "Log in", buttons: [{ text: "Log in" }], screenshotAssetId: "shot-m" },
    links: [],
    meta: {},
  });
}

/** http → https redirect that drops the query string. */
export function utmStrippingSnapshot(): LandingSnapshot {
  return goodSnapshot({
    trackingProbe: {
      sentParams: SENT,
      finalUrl: "https://www.syllacal.com/",
      redirectChain: ["https://www.syllacal.com/"],
    },
  });
}

/** No price on the page, but a Pricing link in the nav. */
export function pricingOneClickSnapshot(): LandingSnapshot {
  return goodSnapshot({
    html: `<html><body><nav><a href="/pricing">Pricing</a></nav><h1>Your syllabus, now a calendar</h1><a href="/start">Get started</a>
      <script>navigator.sendBeacon("/api/marketing/pv")</script></body></html>`,
    links: [
      { href: "https://syllacal.com/pricing", text: "Pricing" },
      { href: "https://syllacal.com/start", text: "Get started" },
    ],
  });
}

export function noOgImageSnapshot(): LandingSnapshot {
  return goodSnapshot({ meta: { "og:title": "SyllaCal", description: "Your syllabus, now a calendar" } });
}
