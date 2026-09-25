import type { CameraKey, ClickEvent } from "@mkt/contracts";

// Synthetic cursor for RecordingAutoZoom (§5.6 step 4, M3b). The real pointer isn't in the
// screencast, so we draw one along a Catmull-Rom path through the click-log points.

export type Point = { tMs: number; x: number; y: number };

/** Uniform Catmull-Rom between p1 and p2 at u∈[0,1]. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

const smoothstep = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Log points in time order, one per timestamp (later wins). */
export function cursorPoints(log: readonly ClickEvent[]): Point[] {
  const byT = new Map<number, Point>();
  for (const e of [...log].sort((a, b) => a.tMs - b.tMs)) byT.set(e.tMs, { tMs: e.tMs, x: e.x, y: e.y });
  return [...byT.values()];
}

/**
 * Cursor position at recording time tMs. Eased per segment so the pointer settles on each
 * click point; holds the first/last point outside the log. Clamped to the frame.
 */
export function cursorAt(points: readonly Point[], tMs: number): { x: number; y: number } | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (tMs <= first.tMs) return { x: first.x, y: first.y };
  if (tMs >= last.tMs) return { x: last.x, y: last.y };
  let i = 0;
  while (i < points.length - 2 && points[i + 1]!.tMs <= tMs) i++;
  const p1 = points[i]!;
  const p2 = points[i + 1]!;
  const p0 = points[i - 1] ?? p1;
  const p3 = points[i + 2] ?? p2;
  const u = smoothstep((tMs - p1.tMs) / Math.max(1, p2.tMs - p1.tMs));
  return { x: clamp01(catmullRom(p0.x, p1.x, p2.x, p3.x, u)), y: clamp01(catmullRom(p0.y, p1.y, p2.y, p3.y, u)) };
}

export const RIPPLE_MS = 450;

/** Clicks whose ripple is visible at tMs, with progress 0..1. */
export function activeRipples(log: readonly ClickEvent[], tMs: number): { x: number; y: number; progress: number }[] {
  return log
    .filter((e) => e.type === "click" && tMs >= e.tMs && tMs < e.tMs + RIPPLE_MS)
    .map((e) => ({ x: e.x, y: e.y, progress: (tMs - e.tMs) / RIPPLE_MS }));
}

export const AUTO_ZOOM = { zoom: 1.8, box: 0.5, leadMs: 600, mergeMs: 1200, zoomOutGapMs: 2500 } as const;

/**
 * Camera keys (scene-relative) that zoom towards each click shortly before it happens, and back
 * out when the next click is far away. Clicks closer together than mergeMs share one move.
 */
export function autoCameraFromClicks(log: readonly ClickEvent[], trimStartMs: number, sceneMs: number): CameraKey[] {
  const clicks = log
    .filter((e) => e.type === "click")
    .map((e) => ({ ...e, r: e.tMs - trimStartMs }))
    .filter((e) => e.r >= 0 && e.r <= sceneMs)
    .sort((a, b) => a.r - b.r);
  const keys: CameraKey[] = [];
  let lastR = Number.NEGATIVE_INFINITY;
  for (const c of clicks) {
    if (c.r - lastR < AUTO_ZOOM.mergeMs) continue;
    if (keys.length > 0 && c.r - lastR > AUTO_ZOOM.zoomOutGapMs) keys.push({ atMs: lastR + 900, zoom: 1 });
    const half = AUTO_ZOOM.box / 2;
    const x = Math.min(1 - AUTO_ZOOM.box, Math.max(0, c.x - half));
    const y = Math.min(1 - AUTO_ZOOM.box, Math.max(0, c.y - half));
    keys.push({ atMs: Math.max(0, c.r - AUTO_ZOOM.leadMs), zoom: AUTO_ZOOM.zoom, focusBox: { x, y, w: AUTO_ZOOM.box, h: AUTO_ZOOM.box } });
    lastR = c.r;
  }
  if (keys.length > 0 && sceneMs - lastR > 1500) keys.push({ atMs: lastR + 900, zoom: 1 });
  return keys;
}
