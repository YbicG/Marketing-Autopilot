import { feature } from "../../ai/features.ts";
import type { RateLookup } from "../../ai/usage.ts";
import { estimateClaudeMicros } from "../../cost/pricing.ts";

/** A first-screen phone screenshot is about 1,600 image tokens (w×h/750 after the API's resize). */
const PHONE_SHOT_TOKENS = 1_600;
const JUDGE_PROMPT_CHARS = 600;

/**
 * Price on the "Run landing check" button: the capture is free; at most one Sonnet look at the
 * phone screenshot, and only when the page check can't find a sign-up button (needsSignupJudge).
 */
export function estimateLandingAuditMicros(rates: RateLookup): number {
  const cfg = feature("launch.landing_judge");
  return estimateClaudeMicros(Math.ceil(PHONE_SHOT_TOKENS * 3.5) + JUDGE_PROMPT_CHARS, cfg.maxTokens, rates(cfg.model));
}
