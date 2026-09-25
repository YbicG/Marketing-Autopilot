import { BODY_MAX_WORDS, HEADLINE_MAX_WORDS, type CarouselSlide, type CarouselTemplate } from "@mkt/contracts";

// Swipe post editor checks (§2.3): text density and contrast, per slide, pure. The colour maths
// mirrors @mkt/video brand/color.ts (deriveBrandTokens), which core can't import; keep them in step.

export interface SlideCheck {
  level: "ok" | "warn" | "block";
  message: string;
}

const HEADLINE_MAX_CHARS = 60;
const BODY_MAX_CHARS = 180;
const DENSE_WORDS = 30;
const TOO_DENSE_WORDS = 50;

const words = (s: string | null | undefined) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

/** Density of one slide: read in about two seconds of scrolling, so the headline carries it. */
export function slideDensity(slide: Pick<CarouselSlide, "headline" | "body">): SlideCheck[] {
  const out: SlideCheck[] = [];
  const hw = words(slide.headline);
  const bw = words(slide.body);
  const total = hw + bw;
  const hc = slide.headline.trim().length;
  const bc = slide.body?.trim().length ?? 0;
  if (!slide.headline.trim()) out.push({ level: "block", message: "Every slide needs a headline." });
  if (hw > HEADLINE_MAX_WORDS || hc > HEADLINE_MAX_CHARS) {
    out.push({ level: "warn", message: `The headline is ${hw} words (${hc} characters); aim for ${HEADLINE_MAX_WORDS} words or fewer.` });
  }
  if (bw > BODY_MAX_WORDS || bc > BODY_MAX_CHARS) {
    out.push({ level: "warn", message: `The body is ${bw} words (${bc} characters); aim for ${BODY_MAX_WORDS} words or fewer.` });
  }
  if (total > TOO_DENSE_WORDS) out.push({ level: "warn", message: `${total} words is too many for one slide. Split it or cut words.` });
  else if (total > DENSE_WORDS) out.push({ level: "warn", message: `${total} words on one slide is a lot for a phone screen.` });
  return out;
}

// ── colour ──

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function rgb(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m?.[1]) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (c: [number, number, number]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

export function luminanceOf(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG 2 contrast ratio, 1..21. */
export function contrastOf(fg: string, bg: string): number {
  const a = luminanceOf(fg);
  const b = luminanceOf(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mixHex(a: string, b: string, t: number): string {
  const x = rgb(a) ?? [0, 0, 0];
  const y = rgb(b) ?? [0, 0, 0];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

const readable = (bg: string) => (contrastOf("#ffffff", bg) >= contrastOf("#0b0b0f", bg) ? "#ffffff" : "#0b0b0f");

export interface SlideColors {
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  primary: string;
  onPrimary: string;
}

/** The still templates' colours from the brand colours (same rules as deriveBrandTokens). */
export function slideColors(brandColors: readonly string[]): SlideColors {
  const valid = brandColors.filter((c) => HEX.test(c));
  const primary = valid[0] ?? "#6366f1";
  const candidate = valid[2];
  const bg = candidate && contrastOf("#ffffff", candidate) >= 7 ? candidate : "#0b0b0f";
  const fg = readable(bg);
  return { bg, surface: mixHex(bg, fg, 0.08), fg, muted: mixHex(fg, bg, 0.35), primary, onPrimary: readable(primary) };
}

/** Which colour pairs each template draws text in (packages/video/src/stills/templates.tsx). */
const PAIRS: Record<CarouselTemplate, { what: string; fg: keyof SlideColors; bg: keyof SlideColors; large: boolean }[]> = {
  hero: [
    { what: "headline", fg: "fg", bg: "bg", large: true },
    { what: "body", fg: "muted", bg: "bg", large: false },
  ],
  problem: [
    { what: "headline", fg: "fg", bg: "bg", large: true },
    { what: "body", fg: "muted", bg: "bg", large: false },
  ],
  feature: [
    { what: "headline", fg: "fg", bg: "bg", large: true },
    { what: "body", fg: "muted", bg: "bg", large: false },
  ],
  steps: [
    { what: "headline", fg: "fg", bg: "bg", large: true },
    { what: "body", fg: "muted", bg: "bg", large: false },
    { what: "step numbers", fg: "onPrimary", bg: "primary", large: true },
  ],
  proof: [
    { what: "headline", fg: "fg", bg: "surface", large: true },
    { what: "body", fg: "muted", bg: "surface", large: false },
  ],
  cta: [
    { what: "headline", fg: "fg", bg: "bg", large: true },
    { what: "button", fg: "onPrimary", bg: "primary", large: false },
  ],
};

/** WCAG contrast per text colour pair: ≥4.5 for body text, ≥3 for large text. */
export function slideContrast(template: CarouselTemplate, colors: SlideColors, hasBody: boolean): SlideCheck[] {
  const out: SlideCheck[] = [];
  for (const p of PAIRS[template]) {
    if (p.what === "body" && !hasBody) continue;
    const ratio = contrastOf(colors[p.fg], colors[p.bg]);
    const need = p.large ? 3 : 4.5;
    if (ratio < need) out.push({ level: "warn", message: `The ${p.what} is hard to read on this background (contrast ${ratio.toFixed(1)}, needs ${need}).` });
  }
  return out;
}

export function slideChecks(slide: Pick<CarouselSlide, "template" | "headline" | "body">, colors: SlideColors): SlideCheck[] {
  return [...slideDensity(slide), ...slideContrast(slide.template, colors, !!slide.body?.trim())];
}
