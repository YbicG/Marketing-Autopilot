import type { BrandSpec } from "@mkt/contracts";
import { BUNDLED_FONT_FAMILY, fontStack } from "../fonts/registry.ts";

export type Rgb = { r: number; g: number; b: number };

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`Not a hex colour: ${hex}`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export const toHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/** WCAG 2 relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, 1..21. Swipe-post check: ≥4.5 body text, ≥3 large text. */
export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const meetsContrast = (fg: string, bg: string, large = false) => contrastRatio(fg, bg) >= (large ? 3 : 4.5);

export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** Whichever of white or near-black reads better on `bg`. */
export const readableOn = (bg: string) => (contrastRatio("#ffffff", bg) >= contrastRatio("#0b0b0f", bg) ? "#ffffff" : "#0b0b0f");

export type BrandTokens = {
  primary: string;
  accent: string;
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  /** Text colour on `primary` (buttons, chips). */
  onPrimary: string;
  fontFamily: string;
  logoAssetId: string | null;
};

const DARK_BG = "#0b0b0f";

/**
 * Brand colours → a small token set. colors[0] is the primary; colors[1] the accent (else a
 * lighter primary); colors[2] the background when it is dark enough to carry white text, else
 * a near-black. Text colours are picked by contrast, never taken on trust.
 */
export function deriveBrandTokens(brand: BrandSpec): BrandTokens {
  const primary = brand.colors[0] ?? "#6366f1";
  const accent = brand.colors[1] ?? mix(primary, "#ffffff", 0.35);
  const candidateBg = brand.colors[2];
  const bg = candidateBg && contrastRatio("#ffffff", candidateBg) >= 7 ? candidateBg : DARK_BG;
  const fg = readableOn(bg);
  return {
    primary,
    accent,
    bg,
    surface: mix(bg, fg, 0.08),
    fg,
    muted: mix(fg, bg, 0.35),
    onPrimary: readableOn(primary),
    fontFamily: fontStack(brand.font),
    logoAssetId: brand.logoAssetId,
  };
}

export const DEFAULT_BRAND: BrandSpec = { colors: ["#6366f1"], font: BUNDLED_FONT_FAMILY, logoAssetId: null };
