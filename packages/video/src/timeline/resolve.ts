import type { VideoSpec } from "@mkt/contracts";

/** Breathing room after each voice line (§5.6 step 3). */
export const VO_PAD_MS = 300;
/** The opening line and the closing card always get at least this long on screen. */
export const HOOK_MIN_MS = 1500;
export const CTA_MIN_MS = 2000;

/** Keys of voice segments that are not scene ids. */
export const HOOK_SEGMENT = "hook";
export const CTA_SEGMENT = "cta";

export type TimelineScene = { id: string; startMs: number; durationMs: number };

export type Timeline = {
  totalMs: number;
  /** The opening line occupies [0, hookMs). */
  hookMs: number;
  /** Spec scenes, back to back from hookMs. */
  scenes: TimelineScene[];
  /** The closing card occupies [ctaStartMs, totalMs). */
  ctaStartMs: number;
  ctaMs: number;
};

const segmentMs = (minMs: number, voMs: number | undefined) =>
  Math.round(Math.max(minMs, voMs !== undefined && voMs > 0 ? voMs + VO_PAD_MS : 0));

/**
 * Timeline: [opening line][scenes...][closing card]. Each segment lasts max(minMs, voice + 300 ms).
 * voDurationsMs is keyed by scene id, plus "hook" (the chosen opening line) and "cta".
 * hookIdx picks the opening line; it doesn't change the math but is validated so callers can't
 * render a variant that doesn't exist.
 */
export function resolveTimeline(spec: VideoSpec, voDurationsMs: Record<string, number>, hookIdx: number): Timeline {
  if (!Number.isInteger(hookIdx) || hookIdx < 0 || hookIdx >= spec.hookVariants.length) {
    throw new RangeError(`hookIdx ${hookIdx} out of range (0..${spec.hookVariants.length - 1})`);
  }
  const hookMs = segmentMs(HOOK_MIN_MS, voDurationsMs[HOOK_SEGMENT]);
  let t = hookMs;
  const scenes = spec.scenes.map((s) => {
    const durationMs = segmentMs(s.minMs, s.vo ? voDurationsMs[s.id] : undefined);
    const out = { id: s.id, startMs: t, durationMs };
    t += durationMs;
    return out;
  });
  const ctaMs = segmentMs(CTA_MIN_MS, voDurationsMs[CTA_SEGMENT]);
  return { totalMs: t + ctaMs, hookMs, scenes, ctaStartMs: t, ctaMs };
}

export const msToFrames = (ms: number, fps: number) => Math.round((ms * fps) / 1000);
/** Total frames, rounded up so the last frame of audio is never cut. */
export const durationInFrames = (totalMs: number, fps: number) => Math.max(1, Math.ceil((totalMs * fps) / 1000));

/** Start of a voice segment ("hook", "cta" or a scene id) on the timeline, or null if unknown. */
export function segmentStartMs(timeline: Timeline, segment: string): number | null {
  if (segment === HOOK_SEGMENT) return 0;
  if (segment === CTA_SEGMENT) return timeline.ctaStartMs;
  return timeline.scenes.find((s) => s.id === segment)?.startMs ?? null;
}
