// Swipe-post text checks (§5.5, §5.7 stage 0): a slide is read in about two seconds of scrolling,
// so the headline carries it and the body stays short.

export type DensitySlide = { headline: string; body?: string };

export const DENSITY_LIMITS = {
  headlineChars: 60,
  bodyChars: 180,
  okWords: 30,
  denseWords: 50,
} as const;

export type TextDensity = {
  words: number;
  headlineChars: number;
  bodyChars: number;
  level: "ok" | "dense" | "too_dense";
  /** Plain-English reasons, empty when ok. */
  reasons: string[];
};

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function textDensity(slide: DensitySlide): TextDensity {
  const headlineChars = slide.headline.trim().length;
  const bodyChars = slide.body?.trim().length ?? 0;
  const total = words(slide.headline) + (slide.body ? words(slide.body) : 0);
  const reasons: string[] = [];
  if (headlineChars > DENSITY_LIMITS.headlineChars) reasons.push(`The headline is ${headlineChars} characters; aim for ${DENSITY_LIMITS.headlineChars} or fewer`);
  if (bodyChars > DENSITY_LIMITS.bodyChars) reasons.push(`The body is ${bodyChars} characters; aim for ${DENSITY_LIMITS.bodyChars} or fewer`);
  if (total > DENSITY_LIMITS.okWords) reasons.push(`${total} words on one slide; split it or cut words`);
  const level =
    total > DENSITY_LIMITS.denseWords || headlineChars > DENSITY_LIMITS.headlineChars * 1.5 || bodyChars > DENSITY_LIMITS.bodyChars * 1.5
      ? "too_dense"
      : reasons.length
        ? "dense"
        : "ok";
  return { words: total, headlineChars, bodyChars, level, reasons };
}
