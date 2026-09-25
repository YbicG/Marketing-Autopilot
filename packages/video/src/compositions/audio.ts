// Music bed under the voice (§5.6 step 5): full level between lines, ducked by duckDb while a
// voice line plays, with short ramps so the dip isn't audible as a click.

export const MUSIC_BASE_VOLUME = 0.35;
export const DUCK_RAMP_MS = 150;

export type Window = { startMs: number; endMs: number };

export const dbToGain = (db: number) => 10 ** (db / 20);

/** 0 (no duck) .. 1 (fully ducked) at tMs, ramping over DUCK_RAMP_MS at each window edge. */
export function duckAmount(windows: readonly Window[], tMs: number): number {
  let amount = 0;
  for (const w of windows) {
    if (tMs < w.startMs - DUCK_RAMP_MS || tMs > w.endMs + DUCK_RAMP_MS) continue;
    let a = 1;
    if (tMs < w.startMs) a = 1 - (w.startMs - tMs) / DUCK_RAMP_MS;
    else if (tMs > w.endMs) a = 1 - (tMs - w.endMs) / DUCK_RAMP_MS;
    amount = Math.max(amount, a);
  }
  return amount;
}

/** Linear music volume at tMs. */
export function musicVolumeAt(windows: readonly Window[], tMs: number, duckDb: number, base = MUSIC_BASE_VOLUME): number {
  const duck = duckAmount(windows, tMs);
  const gain = 1 + (dbToGain(duckDb) - 1) * duck;
  return base * gain;
}
