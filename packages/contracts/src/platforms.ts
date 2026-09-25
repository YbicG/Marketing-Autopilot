import { z } from "zod";

// ── Where posts go (§2.5, §5.4). Assisted-only venues (Reddit, HN…) are not platforms: see @mkt/providers. ──

export const SOCIAL_PLATFORMS = ["tiktok", "instagram", "youtube", "threads", "x", "linkedin", "bluesky"] as const;
export const SocialPlatform = z.enum(SOCIAL_PLATFORMS);
export type SocialPlatform = z.infer<typeof SocialPlatform>;

/** What a slot publishes. "photo" = TikTok photo mode; "document" = LinkedIn PDF; "thread" = several linked posts. */
export const POST_FORMATS = ["video", "photo", "carousel", "text", "thread", "document", "image"] as const;
export const PostFormat = z.enum(POST_FORMATS);
export type PostFormat = z.infer<typeof PostFormat>;

/** How a platform counts characters. X is weighted (links = 23, wide characters = 2); Bluesky counts graphemes. */
export type CountUnit = "x_weighted" | "graphemes" | "utf16";

export interface PlatformLimits {
  label: string;
  unit: CountUnit;
  /** Main text / caption limit. */
  text: number;
  /** Per-format overrides, e.g. TikTok photo descriptions allow 4000. */
  textByFormat?: Partial<Record<PostFormat, number>>;
  /** What one `{{link:…}}` token counts as. X wraps every link in t.co (23). Elsewhere it's the full tracking link. */
  linkLength: number;
  /** Max hashtags per post (null = only the text limit applies). */
  hashtags: number | null;
  /** Title field (YouTube, TikTok photo), when the platform has one. */
  title: number | null;
  /** Max images in one post. */
  maxImages: number;
  formats: readonly PostFormat[];
  /** Bio / profile description limit (bio drafts, §2.3 Where to post step 4). */
  bio: number;
  /** Whether a text post can be pinned to the profile (pinned-post drafts). */
  pinnable: boolean;
}

/** A tracking link with utm_* on a typical landing URL runs ~170 characters (§5.8 step 2). */
const FULL_LINK = 180;

/**
 * Character limits, checked 2026-09. TikTok's Content Posting API: video caption 2200 and photo
 * description 4000 UTF-16 runes, photo title 90. Instagram: caption 2200, 30 hashtags, carousels ≤10
 * (the plan's IG ceiling, §5.5). YouTube: title 100, description 5000. Threads: 500, one topic tag.
 * X: 280 weighted. LinkedIn: 3000. Bluesky: 300 graphemes.
 */
export const PLATFORM_LIMITS: Record<SocialPlatform, PlatformLimits> = {
  tiktok: {
    label: "TikTok",
    unit: "utf16",
    text: 2200,
    textByFormat: { photo: 4000 },
    linkLength: FULL_LINK,
    hashtags: null,
    title: 90,
    maxImages: 35,
    formats: ["video", "photo"],
    bio: 80,
    pinnable: false,
  },
  instagram: {
    label: "Instagram",
    unit: "utf16",
    text: 2200,
    linkLength: FULL_LINK,
    hashtags: 30,
    title: null,
    maxImages: 10,
    formats: ["video", "carousel", "image"],
    bio: 150,
    pinnable: false,
  },
  youtube: {
    label: "YouTube",
    unit: "utf16",
    text: 5000,
    linkLength: FULL_LINK,
    hashtags: 15,
    title: 100,
    maxImages: 0,
    formats: ["video"],
    bio: 1000,
    pinnable: false,
  },
  threads: {
    label: "Threads",
    unit: "utf16",
    text: 500,
    linkLength: FULL_LINK,
    hashtags: 1,
    title: null,
    maxImages: 20,
    formats: ["text", "image", "carousel"],
    bio: 150,
    pinnable: true,
  },
  x: {
    label: "X",
    unit: "x_weighted",
    text: 280,
    linkLength: 23,
    hashtags: null,
    title: null,
    maxImages: 4,
    formats: ["text", "thread", "image"],
    bio: 160,
    pinnable: true,
  },
  linkedin: {
    label: "LinkedIn",
    unit: "utf16",
    text: 3000,
    linkLength: FULL_LINK,
    hashtags: null,
    title: null,
    maxImages: 20,
    formats: ["text", "document", "image"],
    bio: 220,
    pinnable: false,
  },
  bluesky: {
    label: "Bluesky",
    unit: "graphemes",
    text: 300,
    linkLength: FULL_LINK,
    hashtags: null,
    title: null,
    maxImages: 4,
    formats: ["text", "thread", "image"],
    bio: 256,
    pinnable: true,
  },
};

export function textLimit(platform: SocialPlatform, format?: PostFormat): number {
  const l = PLATFORM_LIMITS[platform];
  return (format && l.textByFormat?.[format]) ?? l.text;
}

/** Links only appear as tokens in generated text (§5.0 output discipline); prepare swaps them for tracking links. */
export const LINK_TOKENS = ["landing"] as const;
export type LinkTokenName = (typeof LINK_TOKENS)[number];
export const LINK_TOKEN_RE = /\{\{link:([a-z_]+)\}\}/g;
export const linkToken = (name: LinkTokenName) => `{{link:${name}}}`;

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;

/** Code points X counts as 1 (twitter-text v3 ranges); everything else (CJK, emoji) counts 2. */
function xWeight(cp: number): number {
  if (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) return 1;
  return 2;
}

let segmenter: Intl.Segmenter | null = null;

/**
 * Length of `text` as the platform counts it. Link tokens and raw URLs count as the platform's link
 * length (23 on X). Used by the validators and by the post editor's character counters.
 */
export function countChars(platform: SocialPlatform, text: string): number {
  const l = PLATFORM_LIMITS[platform];
  let links = 0;
  const bare = text.replace(LINK_TOKEN_RE, () => (links++, "")).replace(URL_RE, () => (links++, ""));
  let n = links * l.linkLength;
  if (l.unit === "utf16") return n + bare.length;
  if (l.unit === "graphemes") {
    segmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const _ of segmenter.segment(bare)) n++;
    return n;
  }
  // X: emoji sequences (ZWJ, skin tones, flags) count as one emoji = 2.
  segmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(bare)) {
    const cps = [...segment].map((c) => c.codePointAt(0)!);
    n += cps.length > 1 && cps.some((cp) => cp > 0xffff || cp === 0x200d || cp === 0xfe0f) ? 2 : cps.reduce((s, cp) => s + xWeight(cp), 0);
  }
  return n;
}
