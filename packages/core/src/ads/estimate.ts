import { AD_PLATFORMS } from "@mkt/contracts";
import { feature } from "../ai/features.ts";
import { priceClaudeUsage, SEED_RATES, type RateCard } from "../cost/pricing.ts";

// §7.1 step 1 for the "Make the ads kit · ~$0.xx" button: one ads.concepts call (Opus) plus one
// ads.copy call (Sonnet) per platform, each carrying the campaign bundle.

/** The run cap for an ads_kit generation run (createKitRun should use it): above the worst case below. */
export const ADS_KIT_CAP_MICROS = 2_500_000;

/** A typical frozen campaign bundle (§5.0), in characters. */
export const ADS_BUNDLE_CHARS = 24_000;
/** Task text on top of the bundle: the visuals list, limits and rules. */
const CONCEPT_TASK_CHARS = 4_000;
const COPY_TASK_CHARS = 5_000;
/** Share of max_tokens a structured answer usually uses (thinking included). */
const EXPECTED_OUTPUT_SHARE = 0.3;

const cardFor = (model: string): RateCard => {
  const r = SEED_RATES.find((x) => x.model === model);
  if (!r) throw new Error(`no seed rate for ${model}`);
  return r.rates;
};

function callMicros(feat: "ads.concepts" | "ads.copy", inputChars: number, outputShare: number, cachedChars = 0): number {
  const cfg = feature(feat);
  const input = Math.ceil((inputChars - cachedChars) / 3.5);
  const cached = Math.ceil(cachedChars / 3.5);
  return priceClaudeUsage(
    { input_tokens: input, output_tokens: Math.ceil(cfg.maxTokens * outputShare), cache_read_input_tokens: cached },
    cardFor(cfg.model),
  ).totalMicros;
}

/**
 * Expected and worst-case micros for one ads kit. `high` prices every call at its full max_tokens with
 * no cache hits (what the reserve holds); `expected` assumes the bundle is read from cache after the
 * first Sonnet call and answers use about a third of max_tokens.
 */
export function estimateAdsKitMicros(opts: { bundleChars?: number; platforms?: number } = {}): { expected: number; high: number } {
  const bundle = opts.bundleChars ?? ADS_BUNDLE_CHARS;
  const platforms = opts.platforms ?? AD_PLATFORMS.length;
  const high = callMicros("ads.concepts", bundle + CONCEPT_TASK_CHARS, 1) + platforms * callMicros("ads.copy", bundle + COPY_TASK_CHARS, 1);
  const expected =
    callMicros("ads.concepts", bundle + CONCEPT_TASK_CHARS, EXPECTED_OUTPUT_SHARE) +
    (platforms > 0 ? callMicros("ads.copy", bundle + COPY_TASK_CHARS, EXPECTED_OUTPUT_SHARE) : 0) +
    Math.max(0, platforms - 1) * callMicros("ads.copy", bundle + COPY_TASK_CHARS, EXPECTED_OUTPUT_SHARE, bundle);
  return { expected, high };
}
