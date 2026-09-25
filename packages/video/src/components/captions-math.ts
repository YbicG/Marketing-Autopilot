import { createTikTokStyleCaptions, type TikTokPage } from "@remotion/captions";
import type { Caption } from "@mkt/contracts";

/** Words shown together on one caption page. */
export const COMBINE_WITHIN_MS = 1200;

export function captionPages(captions: readonly Caption[]): TikTokPage[] {
  return createTikTokStyleCaptions({ captions: [...captions], combineTokensWithinMilliseconds: COMBINE_WITHIN_MS }).pages;
}

/** The page visible at tMs (a page lasts until the next starts, capped at its own duration + 400 ms). */
export function pageAt(pages: readonly TikTokPage[], tMs: number): TikTokPage | null {
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i]!;
    if (tMs >= p.startMs) return tMs < p.startMs + p.durationMs + 400 ? p : null;
  }
  return null;
}

/** Share of the video covered by captions, for the §5.7 text-coverage warning. */
export function captionCoverage(captions: readonly Caption[], totalMs: number): number {
  if (totalMs <= 0) return 0;
  const pages = captionPages(captions);
  const covered = pages.reduce((sum, p) => sum + Math.min(p.durationMs, Math.max(0, totalMs - p.startMs)), 0);
  return Math.min(1, covered / totalMs);
}
