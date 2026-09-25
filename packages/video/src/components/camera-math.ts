import type { CameraKey, FocusBox } from "@mkt/contracts";

// Pure camera math, shared by <Camera> and the tests. A key means "start moving here at atMs";
// the move takes MOVE_MS (or less when the next key comes sooner).

export const MOVE_MS = 700;
export const MAX_ZOOM = 4;

export type CameraState = { zoom: number; cx: number; cy: number };
export const IDENTITY: CameraState = { zoom: 1, cx: 0.5, cy: 0.5 };

/** Cubic in-out: slow start, slow stop. */
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export const boxCenter = (b: FocusBox) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 });

/** Zoom that makes `box` fill the frame (the tighter axis wins), capped. */
export const zoomForBox = (b: FocusBox, max = 2.5) => Math.max(1, Math.min(max, 1 / Math.max(b.w, b.h, 1e-3)));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const keyState = (k: CameraKey, prev: CameraState): CameraState => {
  const c = k.focusBox ? boxCenter(k.focusBox) : { cx: prev.cx, cy: prev.cy };
  return { zoom: Math.min(MAX_ZOOM, Math.max(1, k.zoom)), ...c };
};

/** Camera state at tMs (scene-relative). */
export function cameraAt(keys: readonly CameraKey[], tMs: number): CameraState {
  const sorted = [...keys].sort((a, b) => a.atMs - b.atMs);
  let from = IDENTITY;
  for (let i = 0; i < sorted.length; i++) {
    const k = sorted[i]!;
    const to = keyState(k, from);
    if (tMs < k.atMs) return from;
    const next = sorted[i + 1];
    const moveMs = Math.max(1, Math.min(MOVE_MS, next ? next.atMs - k.atMs : MOVE_MS));
    const u = Math.min(1, (tMs - k.atMs) / moveMs);
    if (u < 1) {
      const e = easeInOutCubic(u);
      return { zoom: lerp(from.zoom, to.zoom, e), cx: lerp(from.cx, to.cx, e), cy: lerp(from.cy, to.cy, e) };
    }
    from = to;
  }
  return from;
}

/**
 * CSS transform (origin 0 0) for a camera state on a width×height layer: scale by zoom, then
 * translate so the focus centre sits mid-frame, clamped so the layer's edges never show.
 */
export function cameraTransform(s: CameraState, width: number, height: number): { scale: number; tx: number; ty: number; css: string } {
  const z = s.zoom;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const tx = clamp(width / 2 - s.cx * width * z, width - width * z, 0);
  const ty = clamp(height / 2 - s.cy * height * z, height - height * z, 0);
  return { scale: z, tx, ty, css: `translate(${tx}px, ${ty}px) scale(${z})` };
}
