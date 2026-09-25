// In-page scripts for site capture. Each function runs inside the page via runInPage(), so it must
// stay self-contained: no imports and no references to anything outside its own body.

/** Clicks the cookie banner's "reject"/"necessary only" button, or "accept" if that's the only way out. */
export function clickConsent(): boolean {
  const CONTAINER_RE =
    /cookie|consent|gdpr|ccpa|cmp|privacy|onetrust|didomi|usercentrics|cookiebot|truste|osano|termly|iubenda|quantcast|klaro/i;
  const REJECT_RE =
    /^(reject|decline|deny|refuse|disagree)( all)?( non[- ]essential| optional| additional)?( cookies)?$|^(use |allow )?(only )?(strictly )?(necessary|essential|required) (cookies )?only$|^only (strictly )?(necessary|essential|required)( cookies)?$|^continue without (accepting|agreeing)$/i;
  const ACCEPT_RE = /^(accept|allow|agree|i agree|ok|okay|got it|i understand|understood)( all)?( cookies)?[.!]?$/i;
  const KNOWN_REJECT = [
    "#onetrust-reject-all-handler",
    "#CybotCookiebotDialogBodyButtonDecline",
    "#didomi-notice-disagree-button",
    ".cky-btn-reject",
    ".cmpboxbtnno",
    ".osano-cm-denyAll",
    "[data-testid='uc-deny-all-button']",
    "[data-cookiefirst-action='reject']",
  ];

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const inConsent = (el: Element) => {
    let cur: Element | null = el;
    for (let i = 0; cur && i < 10; i++, cur = cur.parentElement) {
      const hint = `${cur.id} ${cur.getAttribute("class") ?? ""} ${cur.getAttribute("aria-label") ?? ""}`;
      if (CONTAINER_RE.test(hint)) return true;
      const role = cur.getAttribute("role");
      if ((role === "dialog" || role === "alertdialog" || role === "region") && /cookie/i.test(cur.textContent ?? "")) {
        return true;
      }
    }
    return false;
  };

  for (const sel of KNOWN_REJECT) {
    const el = document.querySelector(sel);
    if (el instanceof HTMLElement && visible(el)) {
      el.click();
      return true;
    }
  }

  const candidates = Array.from(
    document.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit]"),
  )
    .slice(0, 3000)
    .filter(visible);
  const label = (el: Element) =>
    ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();

  const reject = candidates.find((el) => {
    const l = label(el);
    return REJECT_RE.test(l) && (inConsent(el) || /cookie/i.test(l));
  });
  const accept = reject ? undefined : candidates.find((el) => ACCEPT_RE.test(label(el)) && inConsent(el));
  const target = reject ?? accept;
  if (target instanceof HTMLElement) {
    target.click();
    return true;
  }
  return false;
}

/** Scrolls down in viewport steps (to trigger lazy images), then back to the top. */
export async function scrollForLazyImages(maxPx: number): Promise<void> {
  const step = Math.max(300, window.innerHeight);
  const end = Math.min(document.documentElement.scrollHeight, maxPx);
  for (let y = step; y < end + step; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
}

export function pageHeight(): number {
  return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight);
}

export interface BrandSample {
  /** [color as rgba(), weight] */
  background: [string, number][];
  text: [string, number][];
  button: [string, number][];
  /** Raw font-family stacks of body, headings and buttons. */
  fontStacks: string[];
  logoUrl: string | null;
  themeColor: string | null;
  description: string | null;
  ogImage: string | null;
  /** Every absolute http(s) link on the page (for discovery and the GitHub link). */
  links: string[];
}

/** Computed-style samples and page meta from the home page. Colors are normalized to rgba() via canvas. */
export function collectBrand(): BrandSample {
  // Computed colors can come back as oklch()/color(); painting one pixel gives plain sRGB.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const memo = new Map<string, string | null>();
  const norm = (css: string | null | undefined): string | null => {
    if (!css || !ctx) return null;
    if (memo.has(css)) return memo.get(css)!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    const out = a === 0 ? null : `rgba(${r}, ${g}, ${b}, ${((a ?? 255) / 255).toFixed(2)})`;
    memo.set(css, out);
    return out;
  };

  const background: [string, number][] = [];
  const text: [string, number][] = [];
  const button: [string, number][] = [];
  const vw = window.innerWidth;
  const els = Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 4000);
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const area = Math.min(rect.width, vw) * Math.min(rect.height, 2000);
    const bg = norm(cs.backgroundColor);
    if (bg) background.push([bg, area / 1000]);
    let own = 0;
    for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE) own += (n.textContent ?? "").trim().length;
    if (own > 0) {
      const c = norm(cs.color);
      if (c) text.push([c, own]);
    }
    if (el.matches("button, [role=button], input[type=submit], a[class*=btn], a[class*=button], a[class*=cta]")) {
      const b = norm(cs.backgroundColor) ?? norm(cs.borderColor);
      if (b) button.push([b, 1]);
    }
  }

  const fontStacks: string[] = [];
  for (const sel of ["body", "h1", "h2", "h3", "button"]) {
    const el = document.querySelector(sel);
    if (el) fontStacks.push(getComputedStyle(el).fontFamily);
  }

  const abs = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try {
      const url = new URL(u, document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  };
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;

  let logoUrl: string | null = null;
  const LOGO_RE = /logo/i;
  const hint = (el: Element) =>
    `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("alt") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
  const logoCandidates = Array.from(
    document.querySelectorAll("header img, header svg, nav img, nav svg, [class*=logo] img, [class*=logo] svg, a[href='/'] img, a[href='/'] svg, img[alt*=logo i]"),
  );
  for (const el of logoCandidates) {
    const parent = el.parentElement;
    if (!LOGO_RE.test(hint(el)) && !(parent && LOGO_RE.test(hint(parent))) && !el.closest("a[href='/']")) continue;
    if (el instanceof HTMLImageElement) {
      logoUrl = abs(el.currentSrc || el.src);
    } else if (el instanceof SVGSVGElement) {
      // Inline SVG logos have no URL of their own; carry the markup as a data URL (size-capped).
      const markup = new XMLSerializer().serializeToString(el);
      if (markup.length <= 50_000) {
        let bin = "";
        for (const byte of new TextEncoder().encode(markup)) bin += String.fromCharCode(byte);
        logoUrl = `data:image/svg+xml;base64,${btoa(bin)}`;
      }
    }
    if (logoUrl) break;
  }

  const links = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href]")).slice(0, 3000)) {
    const href = abs((a as HTMLAnchorElement).href);
    if (href) links.add(href);
  }

  return {
    background,
    text,
    button,
    fontStacks,
    logoUrl,
    themeColor: norm(meta("meta[name='theme-color']")),
    description: meta("meta[name='description']") ?? meta("meta[property='og:description']"),
    ogImage: abs(meta("meta[property='og:image']") ?? meta("meta[name='og:image']") ?? meta("meta[name='twitter:image']")),
    links: [...links],
  };
}

