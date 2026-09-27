import { KIT_LABELS, type KitKind, type KitRunEstimate } from "@mkt/contracts";
import { ADS_KIT_CAP_MICROS, estimateAdsKitMicros } from "../../ads/index.ts";
import { ESTIMATE_HIGH, ESTIMATE_LOW } from "../../engine/estimate.ts";

// §7.1 step 1: a static per-kit table (Sonnet with the cached bundle; the fix pass is in `repair`).
// ads_export is priced here too so one "Make the launch kit" button shows one number.

export const KIT_PRICES: Record<KitKind, number> = {
  subreddit: 90_000,
  ambassador: 60_000,
  press: 150_000,
  creator: 60_000,
  reply_bank: 90_000,
  /** ads.concepts (Opus) + ads.copy (Sonnet) per platform, priced by the ads module. */
  ads_export: estimateAdsKitMicros().expected,
};

/** Expected share of kits needing the one repair call, times its price. */
export const KIT_REPAIR_MICROS = 20_000;
/** A kit run never spends less than this cap allows, so one repair can always finish. */
export const KIT_RUN_MIN_CAP_MICROS = 1_000_000;

/**
 * The written parts share one launch_kit run (cap: 2× high, at least $1); the ads export runs on
 * its own ads_kit run with ADS_KIT_CAP_MICROS. capMicros is the sum of the caps of the runs made.
 */
export function estimateKitRun(kinds: readonly KitKind[]): KitRunEstimate {
  const unique = [...new Set(kinds)];
  const lines = unique.map((kind) => ({ kind, label: KIT_LABELS[kind], expectedMicros: KIT_PRICES[kind] + (kind === "ads_export" ? 0 : KIT_REPAIR_MICROS) }));
  const expected = lines.reduce((n, l) => n + l.expectedMicros, 0);
  const high = Math.round(expected * ESTIMATE_HIGH);
  const written = lines.filter((l) => l.kind !== "ads_export").reduce((n, l) => n + l.expectedMicros, 0);
  const writtenCap = written ? Math.max(KIT_RUN_MIN_CAP_MICROS, Math.ceil((Math.round(written * ESTIMATE_HIGH) * 2) / 100_000) * 100_000) : 0;
  return {
    lines,
    low: Math.round(expected * ESTIMATE_LOW),
    expected,
    high,
    capMicros: writtenCap + (unique.includes("ads_export") ? ADS_KIT_CAP_MICROS : 0),
  };
}
