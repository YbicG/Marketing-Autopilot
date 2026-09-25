export type Tier = "A" | "B" | "C";

const RANK: Record<Tier, number> = { A: 0, B: 1, C: 2 };

/** D18: the post's tier is the highest of its ingredients. */
export function effectiveTier(tiers: Tier[]): Tier {
  return tiers.reduce<Tier>((max, t) => (RANK[t] > RANK[max] ? t : max), "A");
}

/** §5.8 step 2 table: which platform flag each tier sets. */
export const AI_FLAG_RULES: Record<string, { flag: string; tiers: Tier[] }> = {
  tiktok: { flag: "is_aigc", tiers: ["B", "C"] },
  instagram: { flag: "is_ai_generated", tiers: ["B", "C"] },
  youtube: { flag: "containsSyntheticMedia", tiers: ["C"] },
  x: { flag: "made_with_ai", tiers: ["B", "C"] },
};

export const AI_CAPTION_LABEL = "(Made with AI)";

export interface AiDisclosure {
  tier: Tier;
  /** Flags sent to the publisher. */
  flags: Record<string, boolean>;
  /** Appended to the caption when the route can't carry the flag. */
  captionLabel: string | null;
  /** Non-null: this post can't go out on this route. */
  blocked: string | null;
}

/**
 * Map the tier to platform flags. `passThrough` = caps.aiFlags, the flags this publisher route
 * really forwards (confirmed in the M2 spike). When a needed flag doesn't pass through, the caption
 * gets a label instead. `markAsAi` (user override) only ever adds disclosure. Tier C is blocked until M8.
 */
export function aiDisclosureFor(platform: string, tier: Tier, passThrough: string[], markAsAi = false): AiDisclosure {
  if (tier === "C") {
    return { tier, flags: {}, captionLabel: null, blocked: "Posts with AI-generated images or video can't be published yet." };
  }
  const rule = AI_FLAG_RULES[platform];
  const needsFlag = markAsAi || (rule ? rule.tiers.includes(tier) : tier !== "A");
  if (!needsFlag) return { tier, flags: {}, captionLabel: null, blocked: null };
  if (rule && passThrough.includes(rule.flag)) return { tier, flags: { [rule.flag]: true }, captionLabel: null, blocked: null };
  return { tier, flags: {}, captionLabel: AI_CAPTION_LABEL, blocked: null };
}

export function withCaptionLabel(text: string, label: string | null): string {
  if (!label || text.includes(label)) return text;
  return text ? `${text}\n\n${label}` : label;
}
