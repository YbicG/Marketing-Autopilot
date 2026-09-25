import { PACKAGE_CAP_MICROS, type ContentKind, type PackageEstimate, type PackageRecipe, type RecipeLine } from "@mkt/contracts";

// §7.1 step 1 / §7.2: the UI estimate comes from a static per-deliverable table, refreshed later from
// ledger medians (scripts/refresh-prices.ts). Expected cost per unit, in micros.

export const DELIVERABLE_PRICES = {
  /** campaign.plan (Opus): briefs for every planned slot. Once per package. */
  plan: 400_000,
  /** video.script (Opus) + video.spec (Sonnet) + checks, per master. */
  videoMasterLlm: 350_000,
  /** Draft + final voice, music and alignment per master (M3a). Renders are our own CPU. */
  videoMasterMedia: 330_000,
  /** Premium only (M7): AI b-roll per master. */
  videoBroll: 1_000_000,
  /** copy.carousel per swipe post; the stills render on our server for free. */
  carousel: 80_000,
  /** copy.posts, per platform variant. */
  postVariant: 22_500,
  /** copy.posts in thread mode (X), per thread. */
  thread: 60_000,
  bio: 30_000,
  pinned: 30_000,
  /** Checks and at most one fix per scheduled deliverable (copy.repair / qa.text). */
  checks: 20_000,
  /** "Rewrite for this platform". */
  rewrite: 5_000,
} as const;

export const ESTIMATE_LOW = 0.8;
export const ESTIMATE_HIGH = 1.35;

function variants(line: RecipeLine): number {
  return line.targets.reduce((n, t) => n + t.count, 0);
}

/** Expected micros for one line, split into Claude and media. */
export function linePrice(line: RecipeLine, brollPerMaster = false): { llm: number; media: number } {
  const n = line.count;
  const checks = line.scheduled ? n * DELIVERABLE_PRICES.checks : 0;
  switch (line.kind) {
    case "video":
      return {
        llm: n * DELIVERABLE_PRICES.videoMasterLlm + checks,
        media: n * (DELIVERABLE_PRICES.videoMasterMedia + (brollPerMaster ? DELIVERABLE_PRICES.videoBroll : 0)),
      };
    case "carousel":
      return { llm: n * DELIVERABLE_PRICES.carousel + checks, media: 0 };
    case "post":
      return { llm: variants(line) * DELIVERABLE_PRICES.postVariant + checks, media: 0 };
    case "thread":
      return { llm: n * DELIVERABLE_PRICES.thread + checks, media: 0 };
    case "bio":
      return { llm: n * DELIVERABLE_PRICES.bio, media: 0 };
    case "pinned":
      return { llm: n * DELIVERABLE_PRICES.pinned, media: 0 };
    default:
      return { llm: 0, media: 0 };
  }
}

/**
 * Package estimate = recipe × static prices (§7.2), low / expected / high. Only enabled lines count
 * unless `includeDisabled` (the goldens price the full M3a recipe: Standard ≈ $7, Quick ≈ $2.50,
 * Premium ≈ $25).
 */
export function estimatePackage(recipe: PackageRecipe, opts: { includeDisabled?: boolean } = {}): PackageEstimate {
  const lines = recipe.lines.filter((l) => l.enabled || opts.includeDisabled);
  let llm = lines.length ? DELIVERABLE_PRICES.plan : 0;
  let media = 0;
  const out: PackageEstimate["lines"] = [];
  for (const l of lines) {
    const p = linePrice(l, recipe.brollPerMaster);
    llm += p.llm;
    media += p.media;
    out.push({ key: l.key, label: l.label, count: l.count, expectedMicros: p.llm + p.media });
  }
  const expected = llm + media;
  return {
    low: Math.round(expected * ESTIMATE_LOW),
    expected,
    high: Math.round(expected * ESTIMATE_HIGH),
    llmMicros: llm,
    mediaMicros: media,
    capMicros: PACKAGE_CAP_MICROS[recipe.tier],
    lines: out,
  };
}

/** "Open · Make more ~$0.40": the price of filling one open slot of this kind (§2.3 Campaign board). */
export function refillPriceMicros(kind: ContentKind, variantCount = 1): number {
  switch (kind) {
    case "video":
      return DELIVERABLE_PRICES.videoMasterLlm + DELIVERABLE_PRICES.videoMasterMedia + DELIVERABLE_PRICES.checks;
    case "carousel":
      return DELIVERABLE_PRICES.carousel + DELIVERABLE_PRICES.checks;
    case "thread":
      return DELIVERABLE_PRICES.thread + DELIVERABLE_PRICES.checks;
    case "bio":
      return DELIVERABLE_PRICES.bio;
    case "pinned":
      return DELIVERABLE_PRICES.pinned;
    default:
      return variantCount * DELIVERABLE_PRICES.postVariant + DELIVERABLE_PRICES.checks;
  }
}
