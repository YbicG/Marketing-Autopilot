import { z } from "zod";

// ── post state machine names (§4.3). Mirrors POST_STATES in @mkt/db (contracts imports only zod). ──

export const POST_STATE_NAMES = [
  "draft",
  "pending_approval",
  "approved",
  "queued",
  "preparing",
  "submitting",
  "submitted",
  "unknown",
  "awaiting_user",
  "published",
  "failed",
  "missed",
  "paused",
  "canceled",
] as const;
export const PostState = z.enum(POST_STATE_NAMES);
export type PostState = z.infer<typeof PostState>;

export const POST_EVENT_NAMES = [
  "submit_for_approval",
  "approve",
  "enqueue",
  "due",
  "prepared",
  "prepare_invalid",
  "prepare_blocked",
  "prepare_interrupted",
  "accepted",
  "published",
  "failed",
  "no_response",
  "still_pending",
  "lookup_found",
  "lookup_absent",
  "drafts_mode",
  "user_done",
  "post_now",
  "reschedule",
  "edit",
  "void_approval",
  "pause",
  "resume",
  "stale",
  "cancel",
  "posted_manually",
] as const;
export const PostEventName = z.enum(POST_EVENT_NAMES);
export type PostEventName = z.infer<typeof PostEventName>;

// ── TikTok composer (D17, §8 "TikTok composer UX"). Wording is TikTok's, verbatim. ──

/** Shown under the Post button whenever the post has no branded content. */
export const TIKTOK_MUSIC_CONSENT_TEXT = "By posting, you agree to TikTok's Music Usage Confirmation.";
/** Shown instead when "Branded content" is on (TikTok's text covers both policies). */
export const TIKTOK_BRANDED_CONTENT_CONSENT_TEXT =
  "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.";
export const TIKTOK_LABEL_PROMOTIONAL = "Your photo/video will be labeled as 'Promotional content'";
export const TIKTOK_LABEL_PAID_PARTNERSHIP = "Your photo/video will be labeled as 'Paid partnership'";
export const TIKTOK_BRANDED_NOT_PRIVATE_TEXT = "Branded content visibility can't be set to private.";

export const TikTokPrivacyLevel = z.enum([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);
export type TikTokPrivacyLevel = z.infer<typeof TikTokPrivacyLevel>;

export const TikTokCommercialContent = z
  .object({
    enabled: z.boolean().default(false),
    /** "Your brand": promoting yourself or your own business -> "Promotional content". */
    yourBrand: z.boolean().default(false),
    /** "Branded content": promoting a third party -> "Paid partnership". */
    brandedContent: z.boolean().default(false),
  })
  .prefault({});

/** Only increases disclosure: turns the platform AI flag on even for a tier-A post (D18). */
const markAsAi = z.boolean().default(false);

export const TikTokOptions = z
  .object({
    /** No default, ever: the user picks it in the composer (TikTok UX guideline). */
    privacyLevel: TikTokPrivacyLevel,
    disableComment: z.boolean().default(true),
    disableDuet: z.boolean().default(true),
    disableStitch: z.boolean().default(true),
    commercialContent: TikTokCommercialContent,
    /** The user saw TIKTOK_MUSIC_CONSENT_TEXT (or the branded version) and posted anyway. */
    musicConsent: z.literal(true),
    /** Photo mode only. */
    autoAddMusic: z.boolean().default(false),
    /** D17: direct post by default; "drafts" sends to the TikTok inbox and needs a manual finish. */
    postMode: z.enum(["direct", "drafts"]).default("direct"),
    disableInboxFallback: z.boolean().default(true),
    markAsAi,
  })
  .superRefine((o, ctx) => {
    const c = o.commercialContent;
    if (c.enabled && !c.yourBrand && !c.brandedContent) {
      ctx.addIssue({
        code: "custom",
        path: ["commercialContent"],
        message: "Say whether this promotes your own brand, someone else's, or both.",
      });
    }
    if (c.enabled && c.brandedContent && o.privacyLevel === "SELF_ONLY") {
      ctx.addIssue({ code: "custom", path: ["privacyLevel"], message: TIKTOK_BRANDED_NOT_PRIVATE_TEXT });
    }
  });
export type TikTokOptions = z.infer<typeof TikTokOptions>;

/** The consent line the composer must show for these options (verbatim TikTok wording). */
export function tiktokConsentText(o: Pick<TikTokOptions, "commercialContent">): string {
  return o.commercialContent.enabled && o.commercialContent.brandedContent
    ? TIKTOK_BRANDED_CONTENT_CONSENT_TEXT
    : TIKTOK_MUSIC_CONSENT_TEXT;
}

export function tiktokContentLabel(o: Pick<TikTokOptions, "commercialContent">): string | null {
  const c = o.commercialContent;
  if (!c.enabled) return null;
  if (c.brandedContent) return TIKTOK_LABEL_PAID_PARTNERSHIP;
  if (c.yourBrand) return TIKTOK_LABEL_PROMOTIONAL;
  return null;
}

export const InstagramOptions = z.object({
  shareToFeed: z.boolean().default(true),
  firstComment: z.string().max(2200).optional(),
  markAsAi,
});
export type InstagramOptions = z.infer<typeof InstagramOptions>;

export const YouTubeOptions = z.object({
  title: z.string().min(1).max(100),
  /** Asked once per project (products.made_for_kids) and copied here; no default. */
  madeForKids: z.boolean(),
  /** The user may turn this on; the tier mapping turns it on for tier C and it can't be switched off (D18). */
  containsSyntheticMedia: z.boolean().default(false),
  privacyStatus: z.enum(["public", "unlisted", "private"]).default("public"),
  tags: z.array(z.string().max(100)).max(30).default([]),
});
export type YouTubeOptions = z.infer<typeof YouTubeOptions>;

export const XOptions = z.object({
  replySettings: z.enum(["everyone", "following", "mentioned"]).default("everyone"),
  markAsAi,
});
export type XOptions = z.infer<typeof XOptions>;

export const ThreadsOptions = z.object({
  replyControl: z.enum(["everyone", "accounts_you_follow", "mentioned_only"]).default("everyone"),
  markAsAi,
});
export type ThreadsOptions = z.infer<typeof ThreadsOptions>;

export const LinkedInOptions = z.object({
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
  /** Title shown on a document (PDF swipe post). */
  documentTitle: z.string().max(200).optional(),
  markAsAi,
});
export type LinkedInOptions = z.infer<typeof LinkedInOptions>;

/** Platforms without composer options yet (bluesky, facebook, pinterest). */
export const GenericPostOptions = z.object({ markAsAi }).loose();

export const PLATFORM_OPTION_SCHEMAS = {
  tiktok: TikTokOptions,
  instagram: InstagramOptions,
  youtube: YouTubeOptions,
  x: XOptions,
  threads: ThreadsOptions,
  linkedin: LinkedInOptions,
} as const;

export function platformOptionsSchema(platform: string): z.ZodType<Record<string, unknown>> {
  return ((PLATFORM_OPTION_SCHEMAS as Record<string, z.ZodType<Record<string, unknown>>>)[platform] ??
    GenericPostOptions) as z.ZodType<Record<string, unknown>>;
}

/** Parse a post's stored platform_options for its platform. Unknown platforms keep their keys. */
export function parsePlatformOptions(platform: string, raw: unknown) {
  return platformOptionsSchema(platform).safeParse(raw ?? {});
}
