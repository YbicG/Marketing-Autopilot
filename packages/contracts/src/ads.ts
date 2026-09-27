import { z } from "zod";

// ── Ads export kit (§2.3 Ads "January: export kit", §5.1 ads.concepts / ads.copy, §6 Ads "export package") ──
// Export-only until M6: the app never writes to an ads platform and never turns anything on. The kit is
// three concepts plus copy per platform that CJ uploads himself (created paused, 18+, a daily limit
// and an end date). Same conventions as post-set.ts: *Model schemas are what Claude sees.

export const AD_PLATFORMS = ["meta", "tiktok", "reddit", "linkedin", "x", "apple_search_ads"] as const;
export const AdPlatform = z.enum(AD_PLATFORMS);
export type AdPlatform = z.infer<typeof AdPlatform>;

/** Written into every export (README, every sheet, the body) exactly as is. */
export const ADS_SPEND_STATEMENT = "$0 spent by the app — upload these yourself; set a daily limit and an end date on the platform";

export const ADS_CONCEPT_COUNT = 3;
/** Copy variants written per concept on each platform. */
export const ADS_VARIANTS_PER_CONCEPT = 2;

export type AdCopyField = "primaryText" | "headline" | "description";

export interface AdFieldLimit {
  /** Hard limit: over it the platform rejects or cuts the text. Blocks. */
  max: number;
  /** Where the platform starts truncating in most placements. Warns. */
  recommended?: number;
  verified: boolean;
  source: string;
}

export interface AdPlacementSpec {
  name: string;
  /** Our render formats (renders.format) plus 4x5 for feed images. */
  aspect: "9x16" | "1x1" | "16x9" | "4x5";
  notes: string;
}

export interface AdPlatformLimits {
  label: string;
  /** Plain-English name of each text field on this platform; null = the field doesn't exist here. */
  fields: Record<AdCopyField, (AdFieldLimit & { label: string; required: boolean }) | null>;
  /** Button labels the platform offers (the first is the default). Empty = no button field. */
  ctas: readonly string[];
  placements: readonly AdPlacementSpec[];
  /** Apple Search Ads: keywords instead of ad text (the ad itself is the App Store listing). */
  keyword: AdFieldLimit | null;
  /** Only App Store apps can run on this platform. */
  appStoreOnly: boolean;
}

/**
 * Per-platform text limits. None of these could be re-checked against the live ads managers from
 * here (no browsing on this laptop), so every row is `verified: false` except X's 280-character post
 * limit; the sources are the platforms' public ad spec pages as last known. Check on the server
 * before the M6 API work (§11 M6 day-1 spike).
 */
export const ADS_LIMITS: Record<AdPlatform, AdPlatformLimits> = {
  meta: {
    label: "Facebook & Instagram",
    fields: {
      // facebook.com/business/ads-guide: "Primary text 125 characters" (recommended); longer text is cut behind "See more".
      primaryText: { label: "Primary text", required: true, max: 2200, recommended: 125, verified: false, source: "Meta Ads Guide (image/video ads), recommended 125" },
      headline: { label: "Headline", required: true, max: 255, recommended: 40, verified: false, source: "Meta Ads Guide, headline recommended 40" },
      description: { label: "Description", required: false, max: 255, recommended: 30, verified: false, source: "Meta Ads Guide, description recommended 30" },
    },
    ctas: ["Learn more", "Sign up", "Download", "Get offer"],
    placements: [
      { name: "Feeds", aspect: "4x5", notes: "1080×1350 image or video; 1:1 also works." },
      { name: "Stories and Reels", aspect: "9x16", notes: "1080×1920; keep text out of the top and bottom 14%." },
    ],
    keyword: null,
    appStoreOnly: false,
  },
  tiktok: {
    label: "TikTok",
    fields: {
      // TikTok Business Help Center "Ad text": 1–100 characters (Latin); no emoji in some regions.
      primaryText: { label: "Ad text", required: true, max: 100, verified: false, source: "TikTok Ads Manager ad specs, ad text up to 100" },
      headline: null,
      description: null,
    },
    ctas: ["Learn more", "Sign up", "Download", "Get quote"],
    placements: [{ name: "For You feed", aspect: "9x16", notes: "Vertical video 1080×1920, 9–15 s works best; sound on." }],
    keyword: null,
    appStoreOnly: false,
  },
  reddit: {
    label: "Reddit",
    fields: {
      primaryText: null,
      // Reddit Ads help "Ad specs": headline up to 300 characters.
      headline: { label: "Headline", required: true, max: 300, recommended: 100, verified: false, source: "Reddit Ads specs, headline up to 300" },
      description: null,
    },
    ctas: ["Learn More", "Sign Up", "Download", "View More"],
    placements: [
      { name: "Feed", aspect: "4x5", notes: "Image 1080×1350 or 1:1; video 4:5 or 16:9." },
      { name: "Conversation pages", aspect: "16x9", notes: "Landscape image or video under the post." },
    ],
    keyword: null,
    appStoreOnly: false,
  },
  linkedin: {
    label: "LinkedIn",
    fields: {
      // LinkedIn Marketing Solutions "Single image ads specs": intro text 600 max (150 before "see more"), headline 200 max (70 recommended), description 300 max (100 recommended).
      primaryText: { label: "Introductory text", required: true, max: 600, recommended: 150, verified: false, source: "LinkedIn single image ad specs" },
      headline: { label: "Headline", required: true, max: 200, recommended: 70, verified: false, source: "LinkedIn single image ad specs" },
      description: { label: "Description", required: false, max: 300, recommended: 100, verified: false, source: "LinkedIn single image ad specs (shown on the Audience Network only)" },
    },
    ctas: ["Learn more", "Sign up", "Download", "Register"],
    placements: [
      { name: "Feed (single image)", aspect: "1x1", notes: "1200×1200; 1.91:1 landscape also works." },
      { name: "Feed (video)", aspect: "16x9", notes: "Landscape or square video, captions on." },
    ],
    keyword: null,
    appStoreOnly: false,
  },
  x: {
    label: "X",
    fields: {
      // A promoted post is a post: 280 characters for standard accounts (verified); the website card holds the link.
      primaryText: { label: "Post text", required: true, max: 280, verified: true, source: "X post limit, 280 characters" },
      // Website card headline 70 characters (X Ads help "Website cards"), unverified.
      headline: { label: "Website card headline", required: true, max: 70, verified: false, source: "X Ads website card specs" },
      description: null,
    },
    ctas: [],
    placements: [
      { name: "Home timeline", aspect: "1x1", notes: "Image 1200×1200 or 16:9 1200×675; video 16:9 or 1:1." },
      { name: "Home timeline (video)", aspect: "16x9", notes: "Up to 2 min 20 s; 15 s or less works best." },
    ],
    keyword: null,
    appStoreOnly: false,
  },
  apple_search_ads: {
    label: "Apple Search Ads",
    fields: { primaryText: null, headline: null, description: null },
    ctas: [],
    placements: [{ name: "Search results", aspect: "9x16", notes: "Uses your App Store screenshots and text; nothing to upload here." }],
    // Keyword length limit unverified (Apple Search Ads Advanced help).
    keyword: { max: 80, verified: false, source: "Apple Search Ads Advanced keyword help" },
    appStoreOnly: true,
  },
};

const ClaimRef = z.string().regex(/^C\d+$/);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── what Claude returns ──

/** ads.concepts (Opus): one concept. Visual ids must be ones listed in the task. */
export const AdConceptModel = z.object({
  angle: z.string(),
  openingLine: z.string(),
  assetIds: z.array(z.string()),
  renderIds: z.array(z.string()),
  visualDescription: z.string(),
  why: z.string(),
  claimRefs: z.array(z.string()),
});
export type AdConceptModel = z.infer<typeof AdConceptModel>;
export const AdConceptSetModel = z.object({ concepts: z.array(AdConceptModel) });
export type AdConceptSetModel = z.infer<typeof AdConceptSetModel>;

/** ads.copy (Sonnet), one platform per call. Fields the platform lacks come back null. */
export const AdCopyVariantModel = z.object({
  conceptIdx: z.number(),
  primaryText: z.string().nullable(),
  headline: z.string().nullable(),
  description: z.string().nullable(),
  callToAction: z.string().nullable(),
  claimRefs: z.array(z.string()),
});
export const AdCopyModel = z.object({
  variants: z.array(AdCopyVariantModel),
  /** Who to show it to, in plain words (age 18+ always). */
  audience: z.string(),
  /** Apple Search Ads only; empty elsewhere. */
  keywords: z.array(z.string()),
});
export type AdCopyModel = z.infer<typeof AdCopyModel>;

// ── what we store (launch_kits.body for kind "ads_export") ──

export const AdVisual = z.object({
  assetIds: z.array(z.string()),
  renderIds: z.array(z.string()),
  description: z.string(),
});

export const AdConcept = z.object({
  idx: z.number().int().nonnegative(),
  angle: z.string().min(1),
  openingLine: z.string().min(1),
  visual: AdVisual,
  why: z.string().min(1),
  claimRefs: z.array(ClaimRef),
});
export type AdConcept = z.infer<typeof AdConcept>;

export const AdCopy = z.object({
  conceptIdx: z.number().int().nonnegative(),
  primaryText: z.string().nullable(),
  headline: z.string().nullable(),
  description: z.string().nullable(),
  callToAction: z.string().nullable(),
  claimRefs: z.array(ClaimRef),
});
export type AdCopy = z.infer<typeof AdCopy>;

export const AdCreativeRef = z.object({
  conceptIdx: z.number().int().nonnegative(),
  kind: z.enum(["asset", "render"]),
  /** assets.id or renders.id; the export resolves a render to its output file. */
  id: z.string(),
  placement: z.string(),
  aspect: z.string().nullable(),
});
export type AdCreativeRef = z.infer<typeof AdCreativeRef>;

export const AdPlatformExport = z.object({
  platform: AdPlatform,
  /** Why this platform was left out (e.g. Apple Search Ads for a web product), else null. */
  skipped: z.string().nullable(),
  copy: z.array(AdCopy),
  audience: z.string(),
  placements: z.array(z.object({ name: z.string(), aspect: z.string(), notes: z.string() })),
  creatives: z.array(AdCreativeRef),
  keywords: z.array(z.string()),
});
export type AdPlatformExport = z.infer<typeof AdPlatformExport>;

export const AdsExportBody = z.object({
  schemaVersion: z.literal(1),
  launchDate: IsoDate,
  concepts: z.array(AdConcept).length(ADS_CONCEPT_COUNT),
  platforms: z.object({
    meta: AdPlatformExport,
    tiktok: AdPlatformExport,
    reddit: AdPlatformExport,
    linkedin: AdPlatformExport,
    x: AdPlatformExport,
    apple_search_ads: AdPlatformExport,
  }),
  budgetNote: z.string(),
  spendStatement: z.literal(ADS_SPEND_STATEMENT),
});
export type AdsExportBody = z.infer<typeof AdsExportBody>;
