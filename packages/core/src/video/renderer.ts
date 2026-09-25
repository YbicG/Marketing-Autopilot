import type { Caption, ProbeInfo, SpecIssue, StillTemplateId, VideoFormat, VideoSpec } from "@mkt/contracts";

/**
 * Everything core needs from @mkt/video and @mkt/video/render, behind interfaces: core doesn't
 * depend on @mkt/video (the renderer is Node/worker-only and heavy), so the worker binds these to
 * the real module (apps/worker/src/jobs/render/renderer.ts) and tests pass fakes.
 */

// ── Pure, browser-safe helpers from @mkt/video ──

export interface TimelineLike {
  totalMs: number;
  hookMs: number;
  scenes: { id: string; startMs: number; durationMs: number }[];
  ctaStartMs: number;
  ctaMs: number;
}

export interface LintAssetInfo {
  kind: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

export interface LintContext {
  assets: Record<string, LintAssetInfo>;
  publicClaimRefs: Set<string>;
  verifiedClaimRefs: Set<string>;
  voDurationsMs?: Record<string, number>;
}

export type SafeZonePlatform = "meta" | "tiktok" | "yt_short" | "all";
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpecTools {
  resolveTimeline(spec: VideoSpec, voDurationsMs: Record<string, number>, hookIdx: number): TimelineLike;
  lintSpec(spec: VideoSpec, ctx: LintContext): SpecIssue[];
  inSafeZone(box: Rect, platform: SafeZonePlatform, width?: number, height?: number): boolean;
  /**
   * Where the composition puts overlay text and captions, in pixels, for a frame size. Optional:
   * without it QA uses LAYOUT_DEFAULTS (qa-rules.ts), which mirror the scene library's layout.
   */
  layoutBoxes?(spec: VideoSpec, width: number, height: number): { label: string; sceneId?: string; rect: Rect }[];
}

// ── Render props (structurally the AdProps / StillProps of @mkt/video; asset ids only, D8) ──

export type VoSegmentKey = string; // scene id | "hook" | "cta"

export interface AdPropsLike {
  spec: VideoSpec;
  hookIdx: number;
  timeline: TimelineLike;
  audio: { voSegments: { sceneId: VoSegmentKey; assetId: string; durationMs: number }[]; musicAssetId: string | null };
  captions: Caption[] | null;
  aiLabel: boolean;
}

export interface StillPropsLike {
  template: StillTemplateId;
  width: number;
  height: number;
  brand: VideoSpec["brand"];
  slide: { headline: string; body?: string; assetId?: string; index: number; total: number };
}

export interface PlatformVariantFiles {
  tiktok: string;
  ig_reel: string;
  yt_short: string;
  x: string;
  thumb: string;
}

export type ProbePlatform = "master" | "tiktok" | "ig_reel" | "yt_short" | "x";

// ── Node-only renderer (@mkt/video/render + ffmpeg) ──

export interface Renderer {
  renderVideo(opts: {
    spec: VideoSpec;
    hookIdx: number;
    format: VideoFormat;
    quality: "draft" | "final";
    props: AdPropsLike;
    assetFiles: Record<string, string>;
    outPath: string;
    concurrency: number;
  }): Promise<{ path: string; durationMs: number }>;
  renderStillImage(opts: {
    props: StillPropsLike;
    assetFiles: Record<string, string>;
    outPath: string;
    imageFormat: "jpeg" | "png";
    jpegQuality?: number;
  }): Promise<{ path: string }>;
  ffprobe(path: string): Promise<ProbeInfo>;
  /** −14 LUFS / −1.5 dBTP, -g 15 -bf 2 -movflags +faststart. */
  loudnormTwoPass(inPath: string, outPath: string): Promise<void>;
  measureLoudness(path: string): Promise<{ lufs: number; truePeak: number }>;
  transcodeVariants(masterPath: string, outDir: string): Promise<PlatformVariantFiles>;
  /** 3×3 contact sheet (JPEG). */
  contactSheet(masterPath: string, outPath: string): Promise<void>;
  /** One frame as JPEG (QA stage 2 looks at the first 3 s). */
  extractFrame(videoPath: string, atMs: number, outPath: string): Promise<void>;
  /** IPTC digitalSourceType, the last change to the file (§5.6 step 7). */
  writeXmp(path: string, digitalSourceType: string): Promise<void>;
  checkAgainstPlatform(probe: ProbeInfo, platform: ProbePlatform): SpecIssue[];
  buildLinkedInPdf(imagePaths: string[]): Promise<Uint8Array>;
}

// ── Image helpers (sharp is not installed; the worker binds these, tests fake them) ──

/** Decodes an image to 8-bit grayscale, resized to exactly width×height (for dHash). */
export interface ImageDecoder {
  grayscale(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array>;
}

/** Resizes an image to fit inside maxW×maxH and re-encodes it as JPEG (labeling needs a small DPR-1 JPEG). */
export interface ImageResizer {
  toJpeg(bytes: Uint8Array, maxW: number, maxH: number, quality?: number): Promise<{ jpeg: Uint8Array; width: number; height: number; srcWidth: number; srcHeight: number }>;
}
