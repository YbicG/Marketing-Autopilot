// Click log for RecordingAutoZoom (§5.6): pointer events in 0..1 viewport coordinates, timed from the
// first video frame. Raw events come from an in-page listener, so they're untrusted: validate, clamp,
// sort and thin them here.

import type { ClickLogEntry } from "@mkt/contracts";

/** What the in-page listener reports: CSS pixels, epoch milliseconds. */
export interface RawPointerEvent {
  type: unknown;
  /** Epoch ms (performance.timeOrigin + event.timeStamp). */
  t: unknown;
  x: unknown;
  y: unknown;
  /** Viewport size when the event fired. */
  vw: unknown;
  vh: unknown;
}

const TYPES = new Set(["move", "click", "scroll"]);
/** Moves closer together than this are dropped; clicks and scrolls are always kept. */
const MOVE_SPACING_MS = 16;
const MAX_ENTRIES = 20_000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

export function normalizePointerEvent(raw: RawPointerEvent, t0EpochMs: number): ClickLogEntry | null {
  if (typeof raw !== "object" || raw === null || typeof raw.type !== "string" || !TYPES.has(raw.type)) return null;
  const t = num(raw.t);
  const x = num(raw.x);
  const y = num(raw.y);
  const vw = num(raw.vw);
  const vh = num(raw.vh);
  if (t === null || x === null || y === null || !vw || !vh || vw <= 0 || vh <= 0) return null;
  return {
    tMs: Math.max(0, Math.round(t - t0EpochMs)),
    x: round4(clamp01(x / vw)),
    y: round4(clamp01(y / vh)),
    type: raw.type as ClickLogEntry["type"],
  };
}

/** Normalized, time-ordered, thinned. Events after `endEpochMs` (if given) are dropped. */
export function buildClickLog(raws: readonly RawPointerEvent[], t0EpochMs: number, endEpochMs?: number): ClickLogEntry[] {
  const out: ClickLogEntry[] = [];
  for (const r of raws.slice(0, MAX_ENTRIES * 4)) {
    const e = normalizePointerEvent(r, t0EpochMs);
    if (!e) continue;
    if (endEpochMs !== undefined && e.tMs > endEpochMs - t0EpochMs) continue;
    out.push(e);
  }
  out.sort((a, b) => a.tMs - b.tMs);
  const thinned: ClickLogEntry[] = [];
  let lastMove = -Infinity;
  for (const e of out) {
    if (e.type === "move") {
      if (e.tMs - lastMove < MOVE_SPACING_MS) continue;
      lastMove = e.tMs;
    }
    thinned.push(e);
    if (thinned.length === MAX_ENTRIES) break;
  }
  return thinned;
}

/** Center of an element box in CSS px, as the point the synthetic cursor moves to and clicks. */
export function boxCenter(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
