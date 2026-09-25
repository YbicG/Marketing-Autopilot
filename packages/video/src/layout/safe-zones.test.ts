import { describe, expect, it } from "vitest";
import { RIGHT_RAIL_PX, SAFE_ZONES, inSafeZone, outsideFraction, safeRect } from "./safe-zones.ts";

describe("safe zones", () => {
  it("Meta box is x 65–1015, y 269–1248 on 1080×1920", () => {
    expect(SAFE_ZONES.meta).toEqual({ x: 65, y: 269, w: 950, h: 979 });
    expect(inSafeZone({ x: 65, y: 269, w: 950, h: 979 }, "meta")).toBe(true);
    expect(inSafeZone({ x: 60, y: 300, w: 100, h: 100 }, "meta")).toBe(false);
    expect(inSafeZone({ x: 100, y: 1200, w: 100, h: 100 }, "meta")).toBe(false);
  });

  it("keeps text off the TikTok/Shorts right rail", () => {
    const railEdge = 1080 - RIGHT_RAIL_PX;
    expect(inSafeZone({ x: railEdge - 100, y: 800, w: 100, h: 50 }, "tiktok")).toBe(true);
    expect(inSafeZone({ x: railEdge - 99, y: 800, w: 100, h: 50 }, "tiktok")).toBe(false);
    expect(inSafeZone({ x: 900, y: 800, w: 100, h: 50 }, "yt_short")).toBe(false);
    // Meta allows it, the combined zone doesn't.
    expect(inSafeZone({ x: 900, y: 800, w: 100, h: 50 }, "meta")).toBe(true);
    expect(inSafeZone({ x: 900, y: 800, w: 100, h: 50 }, "all")).toBe(false);
  });

  it("the combined zone sits inside every platform zone", () => {
    const all = SAFE_ZONES.all;
    for (const p of ["meta", "tiktok", "yt_short"] as const) expect(inSafeZone(all, p)).toBe(true);
  });

  it("scales for other vertical sizes and uses margins for square/landscape", () => {
    expect(safeRect("meta", 540, 960)).toEqual({ x: 32.5, y: 134.5, w: 475, h: 489.5 });
    expect(safeRect("all", 1080, 1080)).toEqual({ x: 54, y: 54, w: 972, h: 972 });
    expect(safeRect("all", 1920, 1080)).toEqual({ x: 96, y: 54, w: 1728, h: 972 });
  });

  it("measures how much of a box is outside", () => {
    expect(outsideFraction({ x: 100, y: 400, w: 100, h: 100 }, "meta")).toBe(0);
    expect(outsideFraction({ x: 1015, y: 400, w: 100, h: 100 }, "meta")).toBe(1);
    expect(outsideFraction({ x: 965, y: 400, w: 100, h: 100 }, "meta")).toBeCloseTo(0.5);
  });
});
