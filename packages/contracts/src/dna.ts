import { z } from "zod";

// ── Product DNA (§5.2) ──
// Model-facing section schemas are "plain": every field required, nullable where unknown, few unions,
// one section per call. Each section call also returns evidence and unsure items, which merge-evidence
// folds into per-field metadata (Field<T> in the plan) stored alongside the values.

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const Evidence = z.object({
  /** Dotted path of the field this backs, e.g. "identity.oneLiner" or "offer.pricing". */
  path: z.string(),
  /** Evidence-bundle source ids, e.g. ["S1", "S4"]. */
  sourceIds: z.array(z.string()),
  /** Short verbatim quote from the source, when there is one. */
  quote: z.string().nullable(),
  confidence: Confidence,
});
export type Evidence = z.infer<typeof Evidence>;

export const Unsure = z.object({
  path: z.string(),
  /** Plain question the developer can answer in one line. */
  question: z.string(),
});
export type Unsure = z.infer<typeof Unsure>;

export const PLATFORMS = ["web", "ios", "android", "desktop", "cli", "browser_extension", "api"] as const;

export const IdentitySection = z.object({
  name: z.string(),
  oneLiner: z.string(),
  category: z.string(),
  platforms: z.array(z.enum(PLATFORMS)),
  whoItsFor: z.string(),
  audiences: z.array(z.object({ name: z.string(), description: z.string(), painPoints: z.array(z.string()) })),
  /** What they're trying to get done. */
  jobs: z.array(z.string()),
  voice: z.object({ tone: z.string(), wordsToUse: z.array(z.string()), wordsToAvoid: z.array(z.string()) }),
});
export type IdentitySection = z.infer<typeof IdentitySection>;

export const ClaimKind = z.enum(["stat", "feature", "testimonial", "comparison", "price"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const OfferSection = z.object({
  features: z.array(z.object({ name: z.string(), description: z.string() })),
  pricing: z.object({
    model: z.enum(["free", "freemium", "subscription", "one_time", "usage", "mixed", "unknown"]),
    summary: z.string(),
    tiers: z.array(z.object({ name: z.string(), price: z.string(), period: z.string().nullable(), notes: z.string().nullable() })),
  }),
  /** Specific checkable statements that could appear in a post. Never invented. */
  proof: z.array(
    z.object({ kind: ClaimKind, text: z.string(), sourceIds: z.array(z.string()), quote: z.string().nullable() }),
  ),
  differentiators: z.array(z.string()),
});
export type OfferSection = z.infer<typeof OfferSection>;

export const MarketSection = z.object({
  competitors: z.array(z.object({ name: z.string(), url: z.string().nullable(), howTheyDiffer: z.string() })),
  pains: z.array(z.object({ text: z.string(), sourceUrl: z.string().nullable() })),
  seasonality: z.object({
    peaks: z.array(z.object({ months: z.string(), reason: z.string() })),
    summary: z.string(),
  }),
  channels: z.array(z.object({ platform: z.string(), why: z.string() })),
  searchTerms: z.array(z.string()),
});
export type MarketSection = z.infer<typeof MarketSection>;

export const DNA_SECTIONS = {
  identity: IdentitySection,
  offer: OfferSection,
  market: MarketSection,
} as const;
export type DnaSectionId = keyof typeof DNA_SECTIONS;
export const DNA_SECTION_IDS = Object.keys(DNA_SECTIONS) as DnaSectionId[];

/** What one section call returns (the model schema). */
export function sectionOutput<S extends z.ZodType>(values: S) {
  return z.object({ values, evidence: z.array(Evidence), unsure: z.array(Unsure) });
}

export const ProductDna = z.object({
  identity: IdentitySection,
  offer: OfferSection,
  market: MarketSection,
});
export type ProductDna = z.infer<typeof ProductDna>;

/** Per-field metadata, keyed by top-level field path ("identity.oneLiner"). Only the UI sets pinned/editedBy. */
export const FieldMeta = z.object({
  confidence: Confidence,
  sources: z.array(z.string()),
  quote: z.string().nullable(),
  pinned: z.boolean(),
  editedBy: z.enum(["model", "user"]),
  unsure: z.string().nullable(),
});
export type FieldMeta = z.infer<typeof FieldMeta>;
export type FieldMetaMap = Record<string, FieldMeta>;

// ── gap questions (§2.3: ≤5, skippable, never block the run) ──

export const GapQuestionsOutput = z.object({
  questions: z.array(
    z.object({
      path: z.string(),
      question: z.string(),
      why: z.string(),
      /** Up to 4 suggested answers; the UI always allows free text too. */
      options: z.array(z.string()),
    }),
  ),
});
export type GapQuestionsOutput = z.infer<typeof GapQuestionsOutput>;
export const MAX_GAP_QUESTIONS = 5;
