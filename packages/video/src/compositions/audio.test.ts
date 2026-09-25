import { describe, expect, it } from "vitest";
import { DUCK_RAMP_MS, MUSIC_BASE_VOLUME, dbToGain, duckAmount, musicVolumeAt } from "./audio.ts";

describe("music ducking", () => {
  const w = [{ startMs: 1000, endMs: 3000 }];
  it("dB to gain", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-20)).toBeCloseTo(0.1);
    expect(dbToGain(-12)).toBeCloseTo(0.251, 3);
  });
  it("full level between lines, ducked under the voice, ramped at the edges", () => {
    expect(musicVolumeAt(w, 0, -12)).toBeCloseTo(MUSIC_BASE_VOLUME);
    expect(musicVolumeAt(w, 2000, -12)).toBeCloseTo(MUSIC_BASE_VOLUME * dbToGain(-12));
    expect(duckAmount(w, 1000 - DUCK_RAMP_MS / 2)).toBeCloseTo(0.5);
    expect(duckAmount(w, 3000 + DUCK_RAMP_MS / 2)).toBeCloseTo(0.5);
    expect(duckAmount(w, 3000 + DUCK_RAMP_MS + 1)).toBe(0);
  });
  it("overlapping windows never double-duck", () => {
    expect(duckAmount([...w, { startMs: 2000, endMs: 4000 }], 2500)).toBe(1);
  });
});
