import { describe, expect, it } from "vitest";
import type { ClickEvent } from "@mkt/contracts";
import { AUTO_ZOOM, RIPPLE_MS, activeRipples, autoCameraFromClicks, catmullRom, cursorAt, cursorPoints } from "./cursor.ts";

const log: ClickEvent[] = [
  { tMs: 0, x: 0.1, y: 0.1, type: "move" },
  { tMs: 1000, x: 0.5, y: 0.5, type: "click" },
  { tMs: 2000, x: 0.9, y: 0.2, type: "click" },
  { tMs: 6000, x: 0.3, y: 0.8, type: "click" },
];

describe("catmullRom", () => {
  it("passes through the control points", () => {
    expect(catmullRom(0, 1, 2, 3, 0)).toBe(1);
    expect(catmullRom(0, 1, 2, 3, 1)).toBe(2);
    expect(catmullRom(0, 1, 2, 3, 0.5)).toBeCloseTo(1.5);
  });
});

describe("cursorAt", () => {
  const pts = cursorPoints(log);
  it("hits every logged point at its time and holds at the ends", () => {
    for (const e of log) expect(cursorAt(pts, e.tMs)).toEqual({ x: e.x, y: e.y });
    expect(cursorAt(pts, -100)).toEqual({ x: 0.1, y: 0.1 });
    expect(cursorAt(pts, 99_999)).toEqual({ x: 0.3, y: 0.8 });
    expect(cursorAt([], 0)).toBeNull();
  });
  it("stays inside the frame and moves smoothly", () => {
    let prev = cursorAt(pts, 0)!;
    for (let t = 10; t <= 6000; t += 10) {
      const p = cursorAt(pts, t)!;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThan(0.05);
      prev = p;
    }
  });
  it("dedupes equal timestamps, later wins", () => {
    const two: ClickEvent[] = [
      { tMs: 5, x: 0, y: 0, type: "move" },
      { tMs: 5, x: 1, y: 1, type: "click" },
    ];
    expect(cursorPoints(two)).toEqual([{ tMs: 5, x: 1, y: 1 }]);
  });
});

describe("activeRipples", () => {
  it("shows a ripple for RIPPLE_MS after each click", () => {
    expect(activeRipples(log, 1000)).toEqual([{ x: 0.5, y: 0.5, progress: 0 }]);
    expect(activeRipples(log, 1000 + RIPPLE_MS / 2)[0]!.progress).toBeCloseTo(0.5);
    expect(activeRipples(log, 1000 + RIPPLE_MS)).toEqual([]);
    // Moves never ripple.
    expect(activeRipples(log, 0)).toEqual([]);
  });
});

describe("autoCameraFromClicks", () => {
  it("zooms in ahead of each click, merges close clicks, zooms out on long gaps", () => {
    const keys = autoCameraFromClicks(log, 0, 8000);
    expect(keys[0]).toMatchObject({ atMs: 1000 - AUTO_ZOOM.leadMs, zoom: AUTO_ZOOM.zoom });
    // 1000 and 2000 are closer than mergeMs, so they share one move; 6000 gets its own.
    expect(keys.filter((k) => k.zoom > 1)).toHaveLength(2);
    expect(keys.some((k) => k.zoom === 1)).toBe(true);
    for (const k of keys) {
      if (!k.focusBox) continue;
      expect(k.focusBox.x).toBeGreaterThanOrEqual(0);
      expect(k.focusBox.x + k.focusBox.w).toBeLessThanOrEqual(1);
      expect(k.focusBox.y + k.focusBox.h).toBeLessThanOrEqual(1);
    }
  });
  it("respects the trim window", () => {
    const keys = autoCameraFromClicks(log, 1500, 1000);
    expect(keys.filter((k) => k.zoom > 1)).toHaveLength(1);
    expect(keys[0]!.atMs).toBe(0);
  });
});
