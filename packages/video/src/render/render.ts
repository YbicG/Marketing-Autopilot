import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { VideoSpec, type VideoFormat } from "@mkt/contracts";
import { AD_COMPOSITION, STILL_COMPOSITION, type AdProps, type StillProps } from "../compositions/props.ts";
import { ensureBundle, stageBundle } from "./bundle.ts";

/** M0 shape, kept for the smoke test: any composition, no assets. */
export interface RenderVideoInput {
  compositionId: string;
  inputProps: Record<string, unknown>;
  outputLocation: string;
  concurrency: number;
  onProgress?: (fraction: number) => void;
}

/** An "Ad" render (§5.6 step 7). The master still goes through loudnormTwoPass afterwards. */
export interface RenderAdInput {
  spec: VideoSpec;
  hookIdx: number;
  format: VideoFormat;
  quality: "draft" | "final";
  props: AdProps;
  /** assetId → local file; staged at public/a/<assetId> for this render only. */
  assetFiles: Record<string, string>;
  outPath: string;
  concurrency: number;
  onProgress?: (fraction: number) => void;
}

export type RenderVideoResult = { path: string; durationMs: number; durationInFrames: number; fps: number };

/** draft: half size and a lighter encode, for storyboards and QA previews; final: §5.6 settings. */
export const QUALITY = {
  draft: { crf: 26, scale: 0.5 },
  final: { crf: 18, scale: 1 },
} as const;

const isAd = (i: RenderVideoInput | RenderAdInput): i is RenderAdInput => "spec" in i && "props" in i;

/** Validated render props: spec re-parsed (D8), hook/format consistent, editor-only flags off. */
export function adRenderProps(input: Pick<RenderAdInput, "spec" | "hookIdx" | "format" | "props">): AdProps {
  const spec = VideoSpec.parse(input.spec);
  if (spec.format !== input.format) throw new Error(`Format ${input.format} doesn't match the spec (${spec.format})`);
  if (!Number.isInteger(input.hookIdx) || !spec.hookVariants[input.hookIdx]) throw new Error(`No opening line ${input.hookIdx}`);
  return { ...input.props, spec, hookIdx: input.hookIdx, showSafeZones: null };
}

export async function renderVideo(input: RenderVideoInput | RenderAdInput): Promise<RenderVideoResult> {
  const bundleDir = await ensureBundle();
  const ad = isAd(input);
  const compositionId = ad ? AD_COMPOSITION : input.compositionId;
  const inputProps: Record<string, unknown> = ad ? adRenderProps(input) : input.inputProps;
  const outputLocation = ad ? input.outPath : input.outputLocation;
  const q = ad ? QUALITY[input.quality] : QUALITY.final;

  const work = await mkdtemp(join(tmpdir(), "mkt-render-"));
  try {
    const { serveUrl } = await stageBundle(bundleDir, ad ? input.assetFiles : {}, work);
    const composition = await selectComposition({ serveUrl, id: compositionId, inputProps });
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: "h264",
      crf: q.crf,
      scale: q.scale,
      x264Preset: "veryfast",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      // Always an audio track at 48 kHz, so loudnorm and the platforms see what they expect.
      enforceAudioTrack: true,
      sampleRate: 48000,
      concurrency: input.concurrency,
      outputLocation,
      onProgress: ({ progress }) => input.onProgress?.(progress),
    });
    return {
      path: outputLocation,
      durationMs: Math.round((composition.durationInFrames / composition.fps) * 1000),
      durationInFrames: composition.durationInFrames,
      fps: composition.fps,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface RenderStillInput {
  props: StillProps;
  assetFiles: Record<string, string>;
  outPath: string;
  imageFormat: "jpeg" | "png";
  /** JPEG only; default 90 (Instagram takes JPEG only, §5.5). */
  jpegQuality?: number;
}

/**
 * One swipe-post slide or static. Chrome screenshots are sRGB; no ICC profile is embedded, which
 * Instagram and the others read as sRGB.
 */
export async function renderStillImage(input: RenderStillInput): Promise<{ path: string }> {
  const bundleDir = await ensureBundle();
  const inputProps: Record<string, unknown> = { ...input.props, showSafeZones: null };
  const work = await mkdtemp(join(tmpdir(), "mkt-still-"));
  try {
    const { serveUrl } = await stageBundle(bundleDir, input.assetFiles, work);
    const composition = await selectComposition({ serveUrl, id: STILL_COMPOSITION, inputProps });
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      output: input.outPath,
      imageFormat: input.imageFormat,
      ...(input.imageFormat === "jpeg" ? { jpegQuality: input.jpegQuality ?? 90 } : {}),
    });
    return { path: input.outPath };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
