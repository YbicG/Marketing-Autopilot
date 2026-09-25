import { z } from "zod";
import { PostFormat, SocialPlatform } from "./platforms.ts";

// ── PackageRecipe (§5.3, D12): counts = cadence × platforms × 30 days ──

export const PACKAGE_TIERS = ["quick", "standard", "premium"] as const;
export const PackageTier = z.enum(PACKAGE_TIERS);
export type PackageTier = z.infer<typeof PackageTier>;

/** §7.2 per-package caps. */
export const PACKAGE_CAP_MICROS: Record<PackageTier, number> = {
  quick: 5_000_000,
  standard: 12_000_000,
  premium: 40_000_000,
};

/** content_items.kind. "carousel" is a swipe post in the UI. */
export const CONTENT_KINDS = ["post", "thread", "carousel", "video", "email", "bio", "pinned"] as const;
export const ContentKind = z.enum(CONTENT_KINDS);
export type ContentKind = z.infer<typeof ContentKind>;

/**
 * Generators that can be switched on. M2 ships posts, threads, swipe posts and bio/pinned drafts;
 * "video" arrives with M3a and until then its slots are shown as Open.
 */
export const GENERATORS = ["posts", "threads", "carousel", "bio", "video"] as const;
export const GeneratorId = z.enum(GENERATORS);
export type GeneratorId = z.infer<typeof GeneratorId>;
export const M2_GENERATORS: readonly GeneratorId[] = ["posts", "threads", "carousel", "bio"];

export const RecipeTarget = z.object({
  platform: SocialPlatform,
  format: PostFormat,
  /** How many of the line's deliverables go to this platform (item i goes if i < count). */
  count: z.number().int().nonnegative(),
});
export type RecipeTarget = z.infer<typeof RecipeTarget>;

export const RecipeLine = z.object({
  /** Short, colon-free id, used in deliverable keys ("video" → "video:master-03"). */
  key: z.string().regex(/^[a-z0-9-]+$/),
  kind: ContentKind,
  generator: GeneratorId,
  /** False when the generator is off: slots still appear, as Open. */
  enabled: z.boolean(),
  /** Number of deliverables (content items). Each posts to every target whose count covers it. */
  count: z.number().int().nonnegative(),
  targets: z.array(RecipeTarget),
  /** Video masters: opening lines per master (D16). */
  hooksPerMaster: z.number().int().positive().nullable(),
  /** Bio/pinned drafts are not scheduled posts: no calendar slots. */
  scheduled: z.boolean(),
  label: z.string(),
});
export type RecipeLine = z.infer<typeof RecipeLine>;

export const ProductKind = z.enum(["web_b2c", "web_b2b", "mobile", "devtool", "unknown"]);
export type ProductKind = z.infer<typeof ProductKind>;

export const Audience = z.enum(["students", "b2b", "developers", "general"]);
export type Audience = z.infer<typeof Audience>;

export const PackageRecipe = z.object({
  schemaVersion: z.literal(1),
  tier: PackageTier,
  productKind: ProductKind,
  audience: Audience,
  days: z.literal(30),
  platforms: z.array(SocialPlatform),
  lines: z.array(RecipeLine),
  /** Premium only (M7): AI b-roll per master. Priced in the estimate, never generated before M7. */
  brollPerMaster: z.boolean(),
});
export type PackageRecipe = z.infer<typeof PackageRecipe>;

/** Micros. The button shows `expected`; the cap modal compares `high` with the cap (§7.3). */
export const PackageEstimate = z.object({
  low: z.number().int(),
  expected: z.number().int(),
  high: z.number().int(),
  llmMicros: z.number().int(),
  mediaMicros: z.number().int(),
  capMicros: z.number().int(),
  lines: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int(), expectedMicros: z.number().int() })),
});
export type PackageEstimate = z.infer<typeof PackageEstimate>;
