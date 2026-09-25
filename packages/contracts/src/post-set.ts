import { z } from "zod";
import { SocialPlatform } from "./platforms.ts";

// ── PostSet (§5.4): one text deliverable, one variant per platform ──

const ClaimRef = z.string().regex(/^C\d+$/);
const LinkTokenValue = z.literal("{{link:landing}}");

export const PostVariant = z.object({
  platform: SocialPlatform,
  /** The post (the first part, for a thread). Links appear only as `{{link:landing}}`. */
  text: z.string().min(1),
  /** Every part of a thread, in order (text = parts[0]); empty for a single post. */
  parts: z.array(z.string().min(1)),
  hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]+$/u, "hashtag without the #, letters and numbers only")),
  linkToken: LinkTokenValue.nullable(),
  altText: z.string().nullable(),
  firstComment: z.string().nullable(),
  /** Public claim refs backing every number, superlative, quote or competitor fact. */
  claimRefs: z.array(ClaimRef),
});
export type PostVariant = z.infer<typeof PostVariant>;

export const PostSet = z.object({
  variants: z.array(PostVariant).min(1),
});
export type PostSet = z.infer<typeof PostSet>;

/** Model-facing (§5.0): every field required, nullable where optional, no length or pattern keywords. */
export const PostVariantModel = z.object({
  platform: SocialPlatform,
  text: z.string(),
  parts: z.array(z.string()),
  hashtags: z.array(z.string()),
  linkToken: z.enum(["{{link:landing}}"]).nullable(),
  altText: z.string().nullable(),
  firstComment: z.string().nullable(),
  claimRefs: z.array(z.string()),
});
export type PostVariantModel = z.infer<typeof PostVariantModel>;

export const PostSetModel = z.object({ variants: z.array(PostVariantModel) });
export type PostSetModel = z.infer<typeof PostSetModel>;

/** copy.bio: profile text and a pinned-post draft per platform (§2.3 Where to post, step 4). */
export const BioDraftModel = z.object({
  platform: SocialPlatform,
  bio: z.string(),
  /** Null where the platform can't pin a text post. */
  pinnedPost: z.string().nullable(),
});
export const BioSetModel = z.object({ drafts: z.array(BioDraftModel) });
export type BioSetModel = z.infer<typeof BioSetModel>;

/** copy.assisted (Copy & open): a draft for a venue we never post to ourselves. */
export const AssistedDraftModel = z.object({
  title: z.string(),
  body: z.string(),
  /** Rules from the venue's page that shaped this draft, in plain words. */
  rulesSummary: z.array(z.string()),
  /** True when the rules seem to forbid this kind of post at all. */
  likelyNotAllowed: z.boolean(),
});
export type AssistedDraftModel = z.infer<typeof AssistedDraftModel>;

/** What variants.body holds for a text post (schemaVersion per §4.1). */
export const TextVariantBody = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["post", "thread"]),
  variant: PostVariant,
});
export type TextVariantBody = z.infer<typeof TextVariantBody>;
