import { describe, expect, it } from "vitest";
import { makeSpec } from "../spec/fixture.ts";
import { CTA_MIN_MS, HOOK_MIN_MS, VO_PAD_MS, durationInFrames, msToFrames, resolveTimeline, segmentStartMs } from "./resolve.ts";

describe("resolveTimeline", () => {
  const spec = makeSpec();

  it("uses minMs when there is no voice", () => {
    const t = resolveTimeline(spec, {}, 0);
    expect(t.hookMs).toBe(HOOK_MIN_MS);
    expect(t.scenes).toEqual([
      { id: "s1", startMs: HOOK_MIN_MS, durationMs: 2500 },
      { id: "s2", startMs: HOOK_MIN_MS + 2500, durationMs: 3000 },
    ]);
    expect(t.ctaStartMs).toBe(HOOK_MIN_MS + 5500);
    expect(t.ctaMs).toBe(CTA_MIN_MS);
    expect(t.totalMs).toBe(HOOK_MIN_MS + 5500 + CTA_MIN_MS);
  });

  it("stretches each segment to voice + 300 ms when that is longer", () => {
    const t = resolveTimeline(spec, { hook: 2000, s1: 4000, s2: 1000, cta: 2500 }, 1);
    expect(t.hookMs).toBe(2000 + VO_PAD_MS);
    expect(t.scenes[0]).toEqual({ id: "s1", startMs: 2300, durationMs: 4300 });
    expect(t.scenes[1]).toEqual({ id: "s2", startMs: 6600, durationMs: 3000 });
    expect(t.ctaMs).toBe(2800);
    expect(t.totalMs).toBe(2300 + 4300 + 3000 + 2800);
  });

  it("ignores voice lengths for scenes without a voice line", () => {
    const { vo: _vo, ...noVo } = makeSpec().scenes[0]!;
    const s = makeSpec({ scenes: [noVo] });
    expect(resolveTimeline(s, { s1: 9000 }, 0).scenes[0]!.durationMs).toBe(2500);
  });

  it("is contiguous and sums to totalMs over many random inputs", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 200; n++) {
      const count = 1 + Math.floor(rnd() * 8);
      const base = makeSpec().scenes[0]!;
      const scenes = Array.from({ length: count }, (_, i) => ({ ...base, id: `x${i}`, minMs: 300 + Math.floor(rnd() * 5000) }));
      const vo: Record<string, number> = { hook: Math.floor(rnd() * 4000), cta: Math.floor(rnd() * 4000) };
      for (const s of scenes) if (rnd() > 0.3) vo[s.id] = Math.floor(rnd() * 6000);
      const t = resolveTimeline(makeSpec({ scenes }), vo, n % 3);
      let cursor = t.hookMs;
      scenes.forEach((s, i) => {
        const ts = t.scenes[i]!;
        expect(ts.startMs).toBe(cursor);
        expect(ts.durationMs).toBeGreaterThanOrEqual(s.minMs);
        if (vo[s.id] !== undefined && vo[s.id]! > 0) expect(ts.durationMs).toBeGreaterThanOrEqual(vo[s.id]! + VO_PAD_MS);
        cursor += ts.durationMs;
      });
      expect(t.ctaStartMs).toBe(cursor);
      expect(t.totalMs).toBe(cursor + t.ctaMs);
    }
  });

  it("rejects an opening line that doesn't exist", () => {
    expect(() => resolveTimeline(spec, {}, 3)).toThrow(RangeError);
    expect(() => resolveTimeline(spec, {}, -1)).toThrow(RangeError);
  });

  it("finds segment starts", () => {
    const t = resolveTimeline(spec, {}, 0);
    expect(segmentStartMs(t, "hook")).toBe(0);
    expect(segmentStartMs(t, "s2")).toBe(HOOK_MIN_MS + 2500);
    expect(segmentStartMs(t, "cta")).toBe(t.ctaStartMs);
    expect(segmentStartMs(t, "nope")).toBeNull();
  });

  it("converts to frames", () => {
    expect(msToFrames(1000, 30)).toBe(30);
    expect(durationInFrames(1001, 30)).toBe(31);
    expect(durationInFrames(0, 30)).toBe(1);
  });
});
