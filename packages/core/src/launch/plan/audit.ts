import type { LandingAuditCheck } from "@mkt/contracts";

// Landing audit analyzers (§5.4 "Landing audit (gates at M4-LC)"): pure functions over a captured
// snapshot. The worker captures (Playwright + a safe-fetch tracking probe); this file only judges.

export interface LandingViewport {
  /** Visible text inside the first viewport (no scrolling). */
  text: string;
  /** Clickable things (a, button, role=button, submit) whose box starts inside the first viewport. */
  buttons: { text: string; href?: string | null }[];
  screenshotAssetId: string | null;
}

export interface LandingSnapshot {
  requestedUrl: string;
  finalUrl: string;
  /** Every URL redirected to, in order (the browser's chain for the landing itself). */
  redirectChain: string[];
  status: number;
  /** Navigation start → load event, ms. */
  loadMs: number;
  html: string;
  desktop: LandingViewport;
  mobile: LandingViewport;
  links: { href: string; text: string }[];
  /** Hostnames of <script src>. */
  scripts: string[];
  /** Lower-cased meta name/property → content (og:title, og:image, description...). */
  meta: Record<string, string>;
  /** The landing fetched with tracking params (safe-fetch, redirects by hand). */
  trackingProbe: { sentParams: Record<string, string>; finalUrl: string; redirectChain?: string[]; error?: string } | null;
}

/** Optional second opinion on the phone screenshot (launch.landing_judge). */
export interface LandingJudgeResult {
  signupButtonVisible: boolean;
  buttonText: string | null;
  reason: string;
}

export const LOAD_WARN_MS = 3_000;
export const LOAD_GATE_MS = 8_000;

const SIGNUP_TEXT =
  /\b(sign ?up|get started|start (now|free|for free|your free)|try (it|now|free|for free)|create (an |your )?account|join( now| free)?|get (it|the app|access)|download|install|buy( now)?|subscribe|upload (your|a) syllabus|start)\b/i;
const LOGIN_PATH = /^\/(login|log-in|signin|sign-in|sign_in|auth|sso|account\/login|users\/sign_in|session\/new|oauth)(\/|$)/i;
const LOGIN_HOST = /^(auth|login|signin|sso|accounts?|id)\.|(^|\.)(auth0\.com|clerk\.accounts\.dev|accounts\.dev|okta\.com|onelogin\.com|login\.microsoftonline\.com|accounts\.google\.com|cognito[^.]*\.amazonaws\.com)$/i;
const PRICE_AMOUNT = /[$€£]\s?\d{1,5}(?:[.,]\d{1,2})?|\b\d{1,5}(?:[.,]\d{1,2})?\s?(?:usd|eur|gbp|dollars)\b/i;
const PRICE_WORDS = /\bfree forever\b|\bone[- ]time (?:payment|price|fee)\b/i;
const PRICING_LINK = /(^|\/)(pricing|plans|price|prices|buy|purchase)(\/|$|\?|#)|\b(pricing|plans|prices?)\b/i;

const ANALYTICS_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "plausible.io",
  "posthog.com",
  "i.posthog.com",
  "cdn.segment.com",
  "mixpanel.com",
  "cdn.mxpnl.com",
  "va.vercel-scripts.com",
  "vercel-insights.com",
  "static.cloudflareinsights.com",
  "cdn.usefathom.com",
  "umami.is",
  "cloud.umami.is",
  "scripts.simpleanalyticscdn.com",
  "www.clarity.ms",
  "static.hotjar.com",
  "cdn.amplitude.com",
  "cdn.jsdelivr.net/npm/@vercel/analytics",
];
/** The product's own beacon (SyllaCal counts page views itself for the aggregate endpoint). */
const OWN_BEACON = /\/api\/(marketing|analytics|track|events?|beacon|pv)\b|navigator\.sendBeacon|\/_vercel\/insights/i;

/** Tags stripped, entities for the common cases decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&euro;/gi, "€")
    .replace(/&pound;/gi, "£")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLoginUrl(url: string): boolean {
  return LOGIN_PATH.test(pathOf(url)) || LOGIN_HOST.test(hostOf(url));
}

export function checkLoadTime(s: LandingSnapshot): LandingAuditCheck {
  const secs = (s.loadMs / 1000).toFixed(1);
  if (s.loadMs > LOAD_GATE_MS) {
    return { id: "load_time", label: "Page loads fast", passed: false, severity: "gate", detail: `It took ${secs} s to load. Over 8 s, most people leave; make it faster before launch.` };
  }
  if (s.loadMs > LOAD_WARN_MS) {
    return { id: "load_time", label: "Page loads fast", passed: false, severity: "warn", detail: `It took ${secs} s to load. Under 3 s is better on phones.` };
  }
  return { id: "load_time", label: "Page loads fast", passed: true, severity: "warn", detail: `Loaded in ${secs} s.` };
}

function signupIn(v: LandingViewport): string | null {
  const b = v.buttons.find((x) => SIGNUP_TEXT.test(x.text.trim()));
  return b ? b.text.trim() : null;
}

/** true when the DOM heuristic finds no sign-up button on the phone view (the case the judge is for). */
export function needsSignupJudge(s: LandingSnapshot): boolean {
  return !signupIn(s.mobile) && !!s.mobile.screenshotAssetId;
}

export function checkSignupButton(s: LandingSnapshot, judge?: LandingJudgeResult | null): LandingAuditCheck {
  const base = { id: "signup_button" as const, label: "Clear sign-up button without scrolling", severity: "gate" as const };
  const desktop = signupIn(s.desktop);
  let mobile = signupIn(s.mobile);
  let viaJudge = false;
  if (!mobile && judge?.signupButtonVisible) {
    mobile = judge.buttonText || "a sign-up button";
    viaJudge = true;
  }
  const missing = [...(mobile ? [] : ["phones"]), ...(desktop ? [] : ["computers"])];
  if (missing.length) {
    return { ...base, passed: false, detail: `No sign-up or try button shows on ${missing.join(" or ")} before scrolling. Put one near the top.` };
  }
  return { ...base, passed: true, detail: `Found "${mobile}" on phones${viaJudge ? " (checked on the phone screenshot)" : ""} and "${desktop}" on computers.` };
}

export function checkPricingVisible(s: LandingSnapshot): LandingAuditCheck {
  const base = { id: "pricing_visible" as const, label: "Prices are easy to find", severity: "gate" as const };
  const text = htmlToText(s.html);
  const price = PRICE_AMOUNT.exec(text) ?? PRICE_WORDS.exec(text);
  if (price) return { ...base, passed: true, detail: `The page shows a price (${price[0].trim()}).` };
  const site = hostOf(s.finalUrl).replace(/^www\./, "");
  const link = s.links.find((l) => {
    const h = hostOf(l.href).replace(/^www\./, "");
    if (h && site && h !== site) return false;
    return PRICING_LINK.test(pathOf(l.href)) || /\b(pricing|plans|prices?)\b/i.test(l.text);
  });
  if (link) return { ...base, passed: true, detail: `Prices are one click away ("${link.text.trim() || pathOf(link.href)}").` };
  return { ...base, passed: false, detail: "We couldn't find a price on the page or a Pricing link. Show the price, or link to it from the top of the page." };
}

export function checkNoSignupWall(s: LandingSnapshot): LandingAuditCheck {
  const base = { id: "no_signup_wall" as const, label: "No sign-in wall", severity: "gate" as const };
  const hop = [...s.redirectChain, s.finalUrl].find(isLoginUrl);
  if (hop) return { ...base, passed: false, detail: `The page sends visitors to a sign-in page (${pathOf(hop) || hostOf(hop)}). Let people see the landing page without logging in.` };
  if (s.status === 401 || s.status === 403) return { ...base, passed: false, detail: `The page asks for a login (error ${s.status}).` };
  if (s.status >= 400) return { ...base, passed: false, detail: `The page returned an error (${s.status}).` };
  const text = htmlToText(s.html);
  if (/<input[^>]+type=["']?password/i.test(s.html) && text.length < 600) {
    return { ...base, passed: false, detail: "The page is mostly a login form. Put what the product does in front of the sign-in." };
  }
  return { ...base, passed: true };
}

export function checkSharePreview(s: LandingSnapshot): LandingAuditCheck {
  const m = s.meta;
  const missing = [
    ...(m["og:title"]?.trim() ? [] : ["a share title (og:title)"]),
    ...(m["og:image"]?.trim() ? [] : ["a share picture (og:image)"]),
    ...(m.description?.trim() || m["og:description"]?.trim() ? [] : ["a description"]),
  ];
  return {
    id: "share_preview",
    label: "Link preview looks right when shared",
    severity: "warn",
    passed: missing.length === 0,
    ...(missing.length ? { detail: `Missing ${missing.join(", ")}. Shared links will look bare in Reddit, Discord and texts.` } : {}),
  };
}

export function checkAnalytics(s: LandingSnapshot): LandingAuditCheck {
  const base = { id: "analytics" as const, label: "Visit counting is installed", severity: "warn" as const };
  const host = s.scripts.find((h) => ANALYTICS_HOSTS.some((a) => h === a || h.endsWith(`.${a}`) || a.startsWith(`${h}/`)));
  if (host) return { ...base, passed: true, detail: `Found ${host}.` };
  if (OWN_BEACON.test(s.html)) return { ...base, passed: true, detail: "Your site counts its own visits." };
  return { ...base, passed: false, detail: "We didn't see any visit counting on the page. Without it, signups can't be traced to posts." };
}

export function checkTrackingSurvives(s: LandingSnapshot): LandingAuditCheck {
  const base = { id: "tracking_survives" as const, label: "Tracking links survive redirects", severity: "gate" as const };
  const p = s.trackingProbe;
  if (!p || p.error) return { ...base, passed: false, detail: `We couldn't test a tracking link${p?.error ? `: ${p.error}` : "."}` };
  const lost = (url: string) => {
    let q: URLSearchParams;
    try {
      q = new URL(url).searchParams;
    } catch {
      return Object.keys(p.sentParams);
    }
    return Object.entries(p.sentParams)
      .filter(([k, v]) => q.get(k) !== v)
      .map(([k]) => k);
  };
  const dropped = lost(p.finalUrl);
  if (!dropped.length) return { ...base, passed: true };
  const at = (p.redirectChain ?? []).find((u) => lost(u).length > 0);
  return {
    ...base,
    passed: false,
    detail: `A redirect${at ? ` (to ${pathOf(at) || at})` : ""} drops the tracking part of the link (${dropped.join(", ")}), so signups can't be traced to posts. Keep the ?utm_… part when redirecting.`,
  };
}

/** Every check, in display order. */
export function analyzeLanding(s: LandingSnapshot, opts: { judge?: LandingJudgeResult | null } = {}): LandingAuditCheck[] {
  return [
    checkLoadTime(s),
    checkSignupButton(s, opts.judge),
    checkPricingVisible(s),
    checkNoSignupWall(s),
    checkSharePreview(s),
    checkAnalytics(s),
    checkTrackingSurvives(s),
  ];
}

/** gate.landing_audit: every severity "gate" check passes. */
export function landingAuditPassed(checks: readonly LandingAuditCheck[]): boolean {
  return checks.every((c) => c.severity !== "gate" || c.passed);
}

/** The tracking params the probe sends (§5.8 link shape, source "test"). */
export function probeParams(nonce: string): Record<string, string> {
  return { utm_source: "test", utm_medium: "organic", utm_campaign: "launch-check", utm_content: `mkt-audit-${nonce}`, utm_term: "probe" };
}
