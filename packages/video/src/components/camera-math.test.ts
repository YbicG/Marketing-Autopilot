import { describe, expect, it } from "vitest";
import { IDENTITY, MOVE_MS, cameraAt, cameraTransform, zoomForBox } from "./camera-math.ts";

describe("cameraAt", () => {
  const keys = [{ atMs: 1000, zoom: 2, focusBox: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 } }];
  it("holds identity before the first key", () => {
    expect(cameraAt([], 5000)).toEqual(IDENTITY);
    expect(cameraAt(keys, 500)).toEqual(IDENTITY);
  });
  it("eases to the key over MOVE_MS", () => {
    const mid = cameraAt(keys, 1000 + MOVE_MS / 2);
    expect(mid.zoom).toBeCloseTo(1.5, 5);
    expect(mid.cx).toBeCloseTo(0.6, 5);
    expect(cameraAt(keys, 1000 + MOVE_MS)).toEqual({ zoom: 2, cx: 0.7, cy: 0.7 });
    // Slow start.
    expect(cameraAt(keys, 1000 + MOVE_MS * 0.1).zoom - 1).toBeLessThan(0.1);
  });
  it("chains keys and shortens a move when the next key comes sooner", () => {
    const two = [...keys, { atMs: 1300, zoom: 1 }];
    expect(cameraAt(two, 1300).zoom).toBeGreaterThan(1);
    expect(cameraAt(two, 1300 + MOVE_MS).zoom).toBe(1);
  });
  it("sorts keys", () => {
    expect(cameraAt([{ atMs: 2000, zoom: 3 }, ...keys], 5000).zoom).toBe(3);
  });
});

describe("cameraTransform", () => {
  it("is identity at zoom 1", () => {
    expect(cameraTransform(IDENTITY, 1080, 1920)).toMatchObject({ scale: 1, tx: 0, ty: 0 });
  });
  it("centres the focus and never exposes an edge", () => {
    expect(cameraTransform({ zoom: 2, cx: 0.5, cy: 0.5 }, 1000, 1000)).toMatchObject({ scale: 2, tx: -500, ty: -500 });
    const corner = cameraTransform({ zoom: 2, cx: 1, cy: 0 }, 1000, 1000);
    expect(corner.tx).toBe(-1000);
    expect(corner.ty).toBe(0);
  });
  it("zoomForBox", () => {
    expect(zoomForBox({ x: 0, y: 0, w: 0.5, h: 0.25 })).toBe(2);
    expect(zoomForBox({ x: 0, y: 0, w: 0.1, h: 0.1 })).toBe(2.5);
    expect(zoomForBox({ x: 0, y: 0, w: 1, h: 1 })).toBe(1);
  });
});
