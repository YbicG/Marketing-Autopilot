import type { BrandSpec, Caption, ClickEvent, SfxKind, StillTemplateId, VideoFormat, VideoSpec } from "@mkt/contracts";
import type { SafeZonePlatform } from "../layout/safe-zones.ts";
import type { Timeline } from "../timeline/resolve.ts";

export const AD_COMPOSITION = "Ad";
export const STILL_COMPOSITION = "Still";

export const FORMAT_SIZES: Record<VideoFormat, { width: number; height: number }> = {
  "9x16": { width: 1080, height: 1920 },
  "1x1": { width: 1080, height: 1080 },
  "16x9": { width: 1920, height: 1080 },
};

/** Swipe-post / static sizes (§5.5). LinkedIn slides become PDF pages. */
export const STILL_SIZES = {
  ig: { width: 1080, height: 1350 },
  tiktok: { width: 1080, height: 1920 },
  linkedin: { width: 1080, height: 1350 },
  x: { width: 1600, height: 900 },
} as const;
export type StillTarget = keyof typeof STILL_SIZES;

export type VoSegment = { sceneId: string; assetId: string; durationMs: number };

export type AdAudio = {
  /** sceneId is a scene id, "hook" (the chosen opening line) or "cta". */
  voSegments: VoSegment[];
  musicAssetId: string | null;
  /** Optional sound effects for spec.sfx, by kind. */
  sfx?: Partial<Record<SfxKind, string>>;
};

// `type` (not interface) so the props satisfy Remotion's Record<string, unknown> constraint.
export type AdProps = {
  spec: VideoSpec;
  hookIdx: number;
  timeline: Timeline;
  audio: AdAudio;
  /** Word timings on the composition clock (ms from frame 0). */
  captions: Caption[] | null;
  /** Show the "made with AI" chip (provenance tier B/C). */
  aiLabel: boolean;
  /** Recording click logs by asset id (M3b RecordingAutoZoom). */
  clickLogs?: Record<string, ClickEvent[]>;
  /** Pixel size / length of assets by id, when known (fits recordings, holds the last frame). */
  assetMeta?: Record<string, { width?: number | null; height?: number | null; durationMs?: number | null }>;
  /** Editor only: draw the platform safe zones on top. Never set for renders. */
  showSafeZones?: SafeZonePlatform | null;
};

export type StillSlide = {
  headline: string;
  body?: string;
  assetId?: string;
  /** 1-based position in the swipe post. */
  index: number;
  total: number;
  device?: "phone" | "laptop";
};

export type StillProps = {
  template: StillTemplateId;
  width: number;
  height: number;
  brand: BrandSpec;
  slide: StillSlide;
  /** Editor only. */
  showSafeZones?: SafeZonePlatform | null;
};
