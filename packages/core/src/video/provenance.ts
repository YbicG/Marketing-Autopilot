/**
 * D18 provenance tiers. A: captured, uploaded or template. B: text-to-speech (and non-photoreal AI
 * images that pass a check, M7). C: any generative image or video; blocked until M8.
 * An output's tier is the highest tier among its ingredients (asset_lineage).
 */
export type ProvenanceTier = "A" | "B" | "C";

export type Ingredient =
  | { kind: "asset"; origin: "captured" | "uploaded" | "template" | "licensed" | "generated"; provenanceTier?: ProvenanceTier; mediaKind?: string }
  | { kind: "tts" }
  | { kind: "music" }
  | { kind: "sfx" }
  | { kind: "generative_image"; nonPhotorealChecked?: boolean }
  | { kind: "generative_video" };

const RANK: Record<ProvenanceTier, number> = { A: 0, B: 1, C: 2 };

export function maxTier(...tiers: ProvenanceTier[]): ProvenanceTier {
  return tiers.reduce<ProvenanceTier>((a, b) => (RANK[b] > RANK[a] ? b : a), "A");
}

/**
 * AI music and SFX are generated audio, not a depiction of people or product: we tier them B, like
 * TTS, so a video with an AI soundtrack still gets the AI label (conservative; overrides only go up).
 */
export function ingredientTier(i: Ingredient): ProvenanceTier {
  switch (i.kind) {
    case "tts":
    case "music":
    case "sfx":
      return "B";
    case "generative_image":
      return i.nonPhotorealChecked ? "B" : "C";
    case "generative_video":
      return "C";
    case "asset": {
      const own: ProvenanceTier = i.origin === "generated" ? "C" : "A";
      // A stored tier can only raise what the origin implies.
      return maxTier(own, i.provenanceTier ?? "A");
    }
  }
}

export function computeTier(ingredients: readonly Ingredient[]): ProvenanceTier {
  return maxTier(...ingredients.map(ingredientTier));
}

/** Overrides may only increase disclosure (D18): a lower override is ignored. */
export function applyOverride(computed: ProvenanceTier, override: ProvenanceTier | null | undefined): ProvenanceTier {
  return override ? maxTier(computed, override) : computed;
}

export class TierBlocked extends Error {
  readonly code = "tier_blocked";
  constructor() {
    super("This uses AI-generated pictures or video, which we don't post until a later version. Swap that scene for a real screenshot.");
    this.name = "TierBlocked";
  }
}

/** Tier C output is blocked until M8. */
export function assertPublishableTier(tier: ProvenanceTier): void {
  if (tier === "C") throw new TierBlocked();
}

/** The IPTC digitalSourceType written into the file (xmp) for a tier. */
export function digitalSourceType(tier: ProvenanceTier): string {
  const base = "http://cv.iptc.org/newscodes/digitalsourcetype/";
  if (tier === "C") return `${base}trainedAlgorithmicMedia`;
  // Real screens + synthetic voice = a composite that includes AI-made parts.
  if (tier === "B") return `${base}compositeWithTrainedAlgorithmicMedia`;
  return `${base}composite`;
}
