import { z } from "zod";
import { SocialPlatform } from "./platforms.ts";

// ── CarouselSpec (§5.5): a swipe post. Rendered as Remotion stills (D25) by the render.still job. ──

/** Still template ids (render-api.md, D25): the "Still" composition's `template` prop. */
export const CAROUSEL_TEMPLATES = ["hero", "problem", "feature", "steps", "proof", "cta"] as const;
export const CarouselTemplate = z.enum(CAROUSEL_TEMPLATES);
export type CarouselTemplate = z.infer<typeof CarouselTemplate>;

/** Instagram takes ≤10 slides (§2.3); TikTok photo mode takes more, but one spec serves both. */
export const MAX_SLIDES = 10;
export const MIN_SLIDES = 3;
/** Text-density limits (§2.3 Swipe post editor), in words. */
export const HEADLINE_MAX_WORDS = 12;
export const BODY_MAX_WORDS = 40;

/** D8: render props carry asset ids only, never URLs or HTML. */
const looksUnsafe = (s: string) => /(https?:|\/\/|data:|javascript:)/i.test(s) || /<[a-z/!]/i.test(s);
const SafeText = z.string().refine((s) => !looksUnsafe(s), "no links or HTML in slide text");
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const CarouselSlide = z.object({
  template: CarouselTemplate,
  headline: SafeText.min(1),
  body: SafeText.nullable(),
  /** A real screenshot (asset id) shown in a generic device frame, or null for a text-only slide. */
  assetId: Uuid.nullable(),
});
export type CarouselSlide = z.infer<typeof CarouselSlide>;

export const CarouselCaption = z.object({
  text: z.string().min(1),
  hashtags: z.array(z.string()),
});
export type CarouselCaption = z.infer<typeof CarouselCaption>;

export const CarouselSpec = z.object({
  schemaVersion: z.literal(1),
  slides: z.array(CarouselSlide).min(MIN_SLIDES).max(MAX_SLIDES),
  /** One caption per platform the swipe post goes to. Links only as `{{link:landing}}`. */
  captions: z.partialRecord(SocialPlatform, CarouselCaption),
  altText: z.string().nullable(),
  claimRefs: z.array(z.string().regex(/^C\d+$/)),
});
export type CarouselSpec = z.infer<typeof CarouselSpec>;

/** Model-facing: captions as a list (records are awkward in structured output), nullable, no min/max. */
export const CarouselSpecModel = z.object({
  slides: z.array(
    z.object({
      template: CarouselTemplate,
      headline: z.string(),
      body: z.string().nullable(),
      assetId: z.string().nullable(),
    }),
  ),
  captions: z.array(z.object({ platform: SocialPlatform, text: z.string(), hashtags: z.array(z.string()) })),
  altText: z.string().nullable(),
  claimRefs: z.array(z.string()),
});
export type CarouselSpecModel = z.infer<typeof CarouselSpecModel>;

/**
 * variants.body for a swipe post. One variant per platform; the render.still job reads `spec` and
 * `format` and writes the images (IG JPEG 1080×1350, TikTok photo 1080×1920, LinkedIn PDF, X 4 images).
 */
export const CarouselVariantBody = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("carousel"),
  format: z.enum(["carousel", "photo", "document", "image"]),
  spec: CarouselSpec,
  caption: CarouselCaption,
  /** Filled by render.still: asset ids of the rendered slides, in order. */
  renderedAssetIds: z.array(z.string()),
});
export type CarouselVariantBody = z.infer<typeof CarouselVariantBody>;
