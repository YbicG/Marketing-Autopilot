import type { Platform, PlatformCaps } from "../core/types.ts";

/**
 * What each platform accepts through Upload-Post (docs.upload-post.com/resources/character-limits,
 * /api/photo-requirements, /api/video-requirements, /guides/ai-content-labeling; checked 2026-09).
 * `aiFlags` are Upload-Post's native parameter names; a flag not listed here never reaches the
 * platform, so §5.8 says add a caption label or block tiers B/C on that route.
 * Rows marked "unverified" are confirmed in the M2 spike (docs/spikes/upload-post.md).
 */
export const PLATFORM_CAPS: Record<Platform, PlatformCaps> = {
  tiktok: {
    platform: "tiktok",
    postTypes: ["video", "carousel"],
    // Video caption; photo posts: title ≤90, description ≤4000 (TIKTOK_PHOTO_LIMITS).
    maxCaptionChars: 2200,
    maxCarouselItems: 35,
    media: { imageMimes: ["image/jpeg", "image/png", "image/webp"], videoMaxBytes: 4 * 1024 ** 3, videoMaxSeconds: 600 },
    links: "bio_only",
    aiFlags: ["is_aigc"],
    draftMode: true,
    dailyCap: 15,
  },
  instagram: {
    platform: "instagram",
    postTypes: ["image", "carousel", "video"],
    maxCaptionChars: 2200,
    // unverified: Meta's API carousel limit has been 10; the app allows 20. Kept at 10.
    maxCarouselItems: 10,
    media: { imageMimes: ["image/jpeg", "image/png"], videoMaxSeconds: 900 },
    links: "bio_only",
    aiFlags: ["is_ai_generated"],
    draftMode: false,
    // unverified: Meta's content-publishing limit per 24 h.
    dailyCap: 50,
  },
  youtube: {
    platform: "youtube",
    postTypes: ["video"],
    // Description; the title is capped separately at 100 (YOUTUBE_TITLE_MAX).
    maxCaptionChars: 5000,
    media: { imageMimes: [] },
    links: "clickable",
    aiFlags: ["containsSyntheticMedia"],
    draftMode: false,
    // unverified: the per-project quota is shared across Upload-Post customers.
    dailyCap: 10,
  },
  threads: {
    platform: "threads",
    postTypes: ["text", "image", "carousel", "video"],
    // 500 UTF-8 bytes; longer text is split into a thread by Upload-Post.
    maxCaptionChars: 500,
    maxCarouselItems: 20,
    media: { imageMimes: ["image/jpeg", "image/png"], videoMaxSeconds: 300 },
    links: "clickable",
    aiFlags: [],
    draftMode: false,
    dailyCap: 250,
  },
  x: {
    platform: "x",
    postTypes: ["text", "image", "carousel", "video", "thread"],
    maxCaptionChars: 280,
    maxCarouselItems: 4,
    media: { imageMimes: ["image/jpeg", "image/png", "image/webp"], videoMaxSeconds: 140 },
    // D24: Upload-Post strips every URL unless the $19/mo links add-on is on.
    links: "addon",
    // made_with_ai applies to media posts only.
    aiFlags: ["made_with_ai"],
    draftMode: false,
    dailyCap: 50,
  },
  linkedin: {
    platform: "linkedin",
    postTypes: ["text", "image", "carousel", "video", "document"],
    maxCaptionChars: 3000,
    maxCarouselItems: 9,
    media: { imageMimes: ["image/jpeg", "image/png"], videoMaxSeconds: 900 },
    links: "clickable",
    // LinkedIn labels from C2PA credentials in the file; there is no API flag.
    aiFlags: [],
    draftMode: false,
    dailyCap: 25,
  },
  bluesky: {
    platform: "bluesky",
    postTypes: ["text", "image", "carousel", "video"],
    maxCaptionChars: 300,
    maxCarouselItems: 4,
    media: { imageMimes: ["image/jpeg", "image/png", "image/webp"], videoMaxBytes: 300 * 1024 ** 2, videoMaxSeconds: 600 },
    links: "clickable",
    aiFlags: [],
    draftMode: false,
    dailyCap: 25,
  },
  facebook: {
    platform: "facebook",
    postTypes: ["text", "image", "carousel", "video"],
    maxCaptionChars: 63206,
    maxCarouselItems: 10,
    media: { imageMimes: ["image/jpeg", "image/png"] },
    links: "clickable",
    // Reels only.
    aiFlags: ["facebook_is_ai_generated"],
    draftMode: true,
    dailyCap: 25,
  },
  pinterest: {
    platform: "pinterest",
    postTypes: ["image", "carousel", "video"],
    maxCaptionChars: 800,
    maxCarouselItems: 5,
    media: { imageMimes: ["image/jpeg", "image/png"] },
    links: "clickable",
    aiFlags: [],
    draftMode: false,
    dailyCap: 25,
  },
};

export const TIKTOK_PHOTO_LIMITS = { titleMax: 90, descriptionMax: 4000 } as const;
export const YOUTUBE_TITLE_MAX = 100;
export const LINKEDIN_DOCUMENT_TITLE_MAX = 400;

/**
 * §5.8 step 2: provenance tier → the platform's native AI flag. Tier A never sets a flag;
 * YouTube's containsSyntheticMedia is for realistic synthetic media, so only C.
 */
const TIER_FLAGS: Partial<Record<Platform, { flag: string; tiers: ("B" | "C")[] }>> = {
  tiktok: { flag: "is_aigc", tiers: ["B", "C"] },
  instagram: { flag: "is_ai_generated", tiers: ["B", "C"] },
  youtube: { flag: "containsSyntheticMedia", tiers: ["C"] },
  x: { flag: "made_with_ai", tiers: ["B", "C"] },
  facebook: { flag: "facebook_is_ai_generated", tiers: ["B", "C"] },
};

export interface AiFlagMapping {
  flags: Record<string, boolean>;
  /** True when the tier needs disclosure but this route has no flag: label the caption or block. */
  needsCaptionLabel: boolean;
}

export function aiFlagsForTier(platform: Platform, tier: "A" | "B" | "C"): AiFlagMapping {
  const row = TIER_FLAGS[platform];
  if (tier === "A") return { flags: row ? { [row.flag]: false } : {}, needsCaptionLabel: false };
  if (!row) return { flags: {}, needsCaptionLabel: true };
  const on = row.tiers.includes(tier);
  // YouTube tier B (TTS / non-photoreal) needs no synthetic-media flag.
  return { flags: { [row.flag]: on }, needsCaptionLabel: false };
}

export function platformCaps(platform: Platform): PlatformCaps {
  return PLATFORM_CAPS[platform];
}
