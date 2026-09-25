/** D22: model ids live here and in ai_feature_config only. Switching to claude-opus-5-5 is one line. */
export const MODELS = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface FeatureConfig {
  model: ModelId;
  effort: Effort;
  maxTokens: number;
  /** Opus only, synchronous calls only (D14): server-side refusal fallbacks. */
  fallbacks: boolean;
  batchable: boolean;
  promptVersion: string;
}

const opus = (effort: Effort, maxTokens: number, promptVersion = "v1"): FeatureConfig => ({
  model: MODELS.opus,
  effort,
  maxTokens,
  fallbacks: true,
  batchable: false,
  promptVersion,
});
const sonnet = (effort: Effort, maxTokens: number, promptVersion = "v1"): FeatureConfig => ({
  model: MODELS.sonnet,
  effort,
  maxTokens,
  fallbacks: false,
  batchable: false,
  promptVersion,
});

/** Defaults per feature (§5.1). An ai_feature_config row overrides these from M7. */
export const FEATURES = {
  "m0.summary": sonnet("low", 4_000),
  "ingest.classify_text": sonnet("low", 1_000),
  "ingest.label_asset": sonnet("low", 2_000),
  "ingest.extract": sonnet("medium", 8_000),
  "ingest.research": sonnet("medium", 16_000),
  "dna.gaps": sonnet("low", 2_000),
  "dna.synthesize": sonnet("medium", 12_000),
  "dna.one_liner": opus("medium", 4_000),
  "strategy.positioning": opus("high", 32_000),
  "campaign.plan": opus("medium", 16_000),
  "video.script": opus("medium", 16_000),
  "video.spec": sonnet("medium", 12_000),
  "copy.posts": sonnet("medium", 12_000),
  "copy.carousel": sonnet("medium", 8_000),
  "qa.vision": sonnet("low", 4_000),
  "qa.text_judge": sonnet("low", 4_000),
} satisfies Record<string, FeatureConfig>;

export type FeatureId = keyof typeof FEATURES;

export function feature(id: FeatureId): FeatureConfig {
  return FEATURES[id];
}
