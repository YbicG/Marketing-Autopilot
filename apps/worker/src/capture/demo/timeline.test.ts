import { describe, expect, it } from "vitest";
import { frameEpochMs, toCfrFrames, wheelTicks } from "./timeline.ts";

describe("screencast → CFR timing", () => {
  const t0 = 1_760_000_000_000;
  it("times frames from the first one and holds the last until stop", () => {
    const r = toCfrFrames(
      [
        { path: "a", epochMs: t0 },
        { path: "b", epochMs: t0 + 120.4 },
        { path: "c", epochMs: t0 + 1_000 },
      ],
      t0 + 2_500,
    );
    expect(r.frames).toEqual([
      { path: "a", timestampMs: 0 },
      { path: "b", timestampMs: 120 },
      { path: "c", timestampMs: 1_000 },
      { path: "c", timestampMs: 2_500 },
    ]);
    expect(r.t0EpochMs).toBe(t0);
    expect(r.durationMs).toBe(2_533);
  });

  it("never lets a late frame jump back in time", () => {
    const r = toCfrFrames(
      [
        { path: "a", epochMs: t0 },
        { path: "b", epochMs: t0 + 500 },
        { path: "c", epochMs: t0 + 400 },
        { path: "d", epochMs: Number.NaN },
      ],
      t0 + 500,
    );
    expect(r.frames.map((f) => f.timestampMs)).toEqual([0, 500, 500, 500]);
  });

  it("handles no frames", () => {
    expect(toCfrFrames([], t0)).toEqual({ frames: [], t0EpochMs: t0, durationMs: 0 });
  });

  it("reads CDP seconds-since-epoch timestamps", () => {
    expect(frameEpochMs(1_760_000_000.25, 5)).toBe(1_760_000_000_250);
    expect(frameEpochMs(undefined, 5)).toBe(5);
    expect(frameEpochMs(0, 5)).toBe(5);
  });

  it("splits scrolls into small wheel ticks", () => {
    expect(wheelTicks(600, "down")).toEqual([120, 120, 120, 120, 120]);
    expect(wheelTicks(250, "up")).toEqual([-83, -83, -83]);
    expect(wheelTicks(10, "down")).toEqual([10]);
  });
});
