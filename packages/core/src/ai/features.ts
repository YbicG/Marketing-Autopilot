/** D22: model ids live here and in ai_feature_config only. */
export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5",
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** anthropic: the Messages API directly. openrouter: any OpenRouter model, translated in openrouter.ts. */
export type AiProvider = "anthropic" | "openrouter";

export interface FeatureConfig {
  provider: AiProvider;
  model: string;
  effort: Effort;
  maxTokens: number;
  /** Opus only, synchronous calls only (D14): server-side refusal fallbacks. Anthropic only. */
  fallbacks: boolean;
  batchable: boolean;
  promptVersion: string;
}

const opus = (effort: Effort, maxTokens: number, promptVersion = "v1"): FeatureConfig => ({
  provider: "anthropic",
  model: MODELS.opus,
  effort,
  maxTokens,
  fallbacks: true,
  batchable: false,
  promptVersion,
});
const sonnet = (effort: Effort, maxTokens: number, promptVersion = "v1"): FeatureConfig => ({
  provider: "anthropic",
  model: MODELS.sonnet,
  effort,
  maxTokens,
  fallbacks: false,
  batchable: false,
  promptVersion,
});

/** Defaults per feature (§5.1). AI_MODEL_OVERRIDES moves a feature to another model (see modelOverrides). */
export const FEATURES = {
  "m0.summary": sonnet("low", 4_000),
  "ingest.classify_text": sonnet("low", 1_000),
  "ingest.label_asset": sonnet("low", 2_000),
  "ingest.extract": sonnet("medium", 8_000),
  "ingest.research": sonnet("medium", 16_000),
  "ingest.research_summary": sonnet("medium", 8_000),
  "dna.gaps": sonnet("low", 2_000),
  "dna.synthesize": sonnet("medium", 12_000),
  "dna.one_liner": opus("medium", 4_000),
  "strategy.positioning": opus("high", 32_000),
  "campaign.plan": opus("medium", 16_000),
  "video.script": opus("medium", 16_000),
  "video.spec": sonnet("medium", 12_000),
  "copy.posts": sonnet("medium", 12_000),
  "copy.carousel": sonnet("medium", 8_000),
  "copy.rewrite_platform": sonnet("low", 4_000),
  "copy.bio": sonnet("low", 4_000),
  "copy.assisted": sonnet("medium", 8_000),
  "copy.repair": sonnet("low", 8_000),
  "video.hooks_more": opus("medium", 6_000),
  "video.change_request": sonnet("medium", 12_000),
  "capture.flow_plan": sonnet("medium", 8_000),
  "qa.vision": sonnet("low", 4_000),
  "qa.text_judge": sonnet("low", 4_000),
  "qa.pii_frames": sonnet("low", 4_000),
  "launch.kit.subreddit": sonnet("medium", 12_000),
  "launch.kit.ambassador": sonnet("medium", 8_000),
  "launch.kit.press": sonnet("medium", 16_000),
  "launch.kit.creator": sonnet("medium", 8_000),
  "launch.kit.reply_bank": sonnet("medium", 12_000),
  "launch.landing_judge": sonnet("low", 4_000),
  "copy.email": sonnet("medium", 8_000),
  "ads.concepts": opus("medium", 12_000),
  "ads.copy": sonnet("medium", 12_000),
  /** The model eval's blind judge (scripts/model-eval.ts). Never overridden. */
  "eval.judge": opus("high", 6_000),
} satisfies Record<string, FeatureConfig>;

export type FeatureId = keyof typeof FEATURES;

export interface ModelOverride {
  provider: AiProvider;
  model: string;
  effort?: Effort;
}

const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * Parse AI_MODEL_OVERRIDES: `feature=provider:model[@effort]`, separated by `;` or `,`.
 * Example: `ingest.label_asset=openrouter:z-ai/glm-5.3-flash;dna.gaps=openrouter:openai/gpt-6-luna@high`.
 * Unknown features and malformed entries are reported, never silently applied.
 */
export function parseModelOverrides(raw: string | undefined): { overrides: Map<FeatureId, ModelOverride>; errors: string[] } {
  const overrides = new Map<FeatureId, ModelOverride>();
  const errors: string[] = [];
  for (const entry of (raw ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9_.]+)=(anthropic|openrouter):([^@\s]+)(?:@([a-z]+))?$/.exec(entry);
    if (!m) {
      errors.push(`"${entry}" isn't feature=provider:model[@effort]`);
      continue;
    }
    const [, id, provider, model, effort] = m;
    if (!(id! in FEATURES)) errors.push(`unknown feature "${id}"`);
    else if (id === "eval.judge") errors.push(`eval.judge can't be overridden`);
    else if (effort && !EFFORTS.has(effort as Effort)) errors.push(`unknown effort "${effort}" in "${entry}"`);
    else overrides.set(id as FeatureId, { provider: provider as AiProvider, model: model!, ...(effort ? { effort: effort as Effort } : {}) });
  }
  return { overrides, errors };
}

let cached: { raw: string | undefined; overrides: Map<FeatureId, ModelOverride> } | undefined;

function envOverrides(): Map<FeatureId, ModelOverride> {
  const raw = process.env.AI_MODEL_OVERRIDES;
  if (cached && cached.raw === raw) return cached.overrides;
  const { overrides, errors } = parseModelOverrides(raw);
  if (errors.length) console.warn("[ai] AI_MODEL_OVERRIDES ignored entries:", errors.join("; "));
  cached = { raw, overrides };
  return overrides;
}

export function feature(id: FeatureId, overrides: Map<FeatureId, ModelOverride> = envOverrides()): FeatureConfig {
  const base: FeatureConfig = FEATURES[id];
  const o = overrides.get(id);
  if (!o) return base;
  // Refusal fallbacks are an Anthropic beta, and only for the Opus defaults.
  return { ...base, provider: o.provider, model: o.model, effort: o.effort ?? base.effort, fallbacks: o.provider === "anthropic" && base.fallbacks && o.model === base.model };
}
