// Binds core's Renderer / SpecTools interfaces (packages/core/src/video/renderer.ts) to
// @mkt/video and @mkt/video/render. Worker only: this pulls in Remotion and ffmpeg.

import type { Renderer, SpecTools } from "@mkt/core/video";
import { inSafeZone, lintSpec, resolveTimeline } from "@mkt/video";
import {
  buildLinkedInPdf,
  checkAgainstPlatform,
  contactSheet,
  defaultRunner,
  ffprobe,
  loudnormTwoPass,
  measureLoudness,
  renderStillImage,
  renderVideo,
  tools,
  transcodeVariants,
  writeXmp,
  type FfTools,
} from "@mkt/video/render";

export const specTools: SpecTools = {
  resolveTimeline: (spec, vo, hookIdx) => resolveTimeline(spec, vo, hookIdx),
  lintSpec: (spec, ctx) => lintSpec(spec, ctx),
  inSafeZone: (box, platform, w, h) => inSafeZone(box, platform, w, h),
};

/** One frame as a JPEG (argv only, never a shell). Seeks before -i: fast and exact enough for QA. */
export function extractFrameArgs(input: string, atMs: number, output: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-y", "-ss", (Math.max(0, atMs) / 1000).toFixed(3), "-i", input, "-frames:v", "1", "-q:v", "3", output];
}

export interface VideoRendererOptions {
  ff?: FfTools;
  /** EXIFTOOL_PATH when the image ships exiftool; otherwise the native XMP writer. */
  exiftoolPath?: string | null;
}

export function createVideoRenderer(opts: VideoRendererOptions = {}): Renderer {
  const ff = opts.ff ?? {};
  return {
    async renderVideo(o) {
      const r = await renderVideo({ spec: o.spec, hookIdx: o.hookIdx, format: o.format, quality: o.quality, props: o.props, assetFiles: o.assetFiles, outPath: o.outPath, concurrency: o.concurrency });
      return { path: r.path, durationMs: r.durationMs };
    },
    renderStillImage: (o) =>
      renderStillImage({ props: o.props, assetFiles: o.assetFiles, outPath: o.outPath, imageFormat: o.imageFormat, ...(o.jpegQuality !== undefined ? { jpegQuality: o.jpegQuality } : {}) }),
    ffprobe: (path) => ffprobe(path, ff),
    async loudnormTwoPass(inPath, outPath) {
      await loudnormTwoPass(inPath, outPath, ff);
    },
    async measureLoudness(path) {
      const m = await measureLoudness(path, ff);
      return { lufs: m.lufs, truePeak: m.truePeak };
    },
    transcodeVariants: (master, outDir) => transcodeVariants(master, outDir, ff),
    async contactSheet(master, out) {
      await contactSheet(master, out, ff);
    },
    async extractFrame(video, atMs, out) {
      const t = tools(ff);
      await (t.run ?? defaultRunner)(t.ffmpeg, extractFrameArgs(video, atMs, out));
    },
    async writeXmp(path, dst) {
      await writeXmp(path, dst, { exiftoolPath: opts.exiftoolPath ?? null, ...(ff.run ? { run: ff.run } : {}) });
    },
    checkAgainstPlatform: (probe, platform) => checkAgainstPlatform(probe, platform),
    buildLinkedInPdf: (paths) => buildLinkedInPdf(paths),
  };
}
