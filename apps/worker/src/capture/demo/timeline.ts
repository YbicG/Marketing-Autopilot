// Pure helpers for the demo recorder (no Playwright): screencast frame timing for framesToCfr.

export interface ScreencastFrame {
  path: string;
  /** Page.screencastFrame metadata.timestamp × 1000 (epoch ms), or the arrival time when missing. */
  epochMs: number;
}

export interface CfrFrame {
  path: string;
  timestampMs: number;
}

/**
 * Screencast frames arrive only when the page repaints, with the compositor's timestamps. framesToCfr
 * holds each frame until the next one, so: times are made relative to the first frame, forced to be
 * non-decreasing (a late frame can't jump back), and the last frame is repeated at `stopEpochMs` so
 * the final screen is held until the recording actually stopped.
 */
export function toCfrFrames(frames: readonly ScreencastFrame[], stopEpochMs: number): { frames: CfrFrame[]; t0EpochMs: number; durationMs: number } {
  if (frames.length === 0) return { frames: [], t0EpochMs: stopEpochMs, durationMs: 0 };
  const t0 = frames[0]!.epochMs;
  const out: CfrFrame[] = [];
  let prev = 0;
  for (const f of frames) {
    const t = Number.isFinite(f.epochMs) ? Math.max(prev, Math.round(f.epochMs - t0)) : prev;
    out.push({ path: f.path, timestampMs: t });
    prev = t;
  }
  const end = Math.max(prev, Math.round(stopEpochMs - t0));
  if (end > prev) out.push({ path: out[out.length - 1]!.path, timestampMs: end });
  // At 30 fps the last frame still lasts one frame.
  return { frames: out, t0EpochMs: t0, durationMs: end + Math.round(1000 / 30) };
}

/** Screencast metadata.timestamp is seconds since the epoch (float); fall back to wall clock. */
export function frameEpochMs(metadataTimestamp: number | undefined, nowMs: number): number {
  return typeof metadataTimestamp === "number" && Number.isFinite(metadataTimestamp) && metadataTimestamp > 0
    ? metadataTimestamp * 1000
    : nowMs;
}

/** Scroll in small wheel ticks so the footage glides instead of jumping. */
export function wheelTicks(amountPx: number, direction: "down" | "up", tickPx = 120): number[] {
  const n = Math.max(1, Math.ceil(Math.abs(amountPx) / tickPx));
  const sign = direction === "down" ? 1 : -1;
  const per = Math.abs(amountPx) / n;
  return Array.from({ length: n }, () => sign * Math.round(per));
}
