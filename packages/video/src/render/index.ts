// Node-only entry: bundling and rendering. The worker imports this; the web app never does.
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";

const ENTRY = fileURLToPath(new URL("../entry.ts", import.meta.url));

let bundled: Promise<string> | undefined;

/**
 * One bundle per process; renders reuse its serve URL. Webpack's disk cache is off because
 * node_modules is root-owned in the worker image; the bundle goes to the OS temp dir.
 */
export function getBundle(): Promise<string> {
  bundled ??= bundle({ entryPoint: ENTRY, enableCaching: false });
  return bundled;
}

export { ensureBrowser };

export interface RenderVideoInput {
  compositionId: string;
  inputProps: Record<string, unknown>;
  outputLocation: string;
  concurrency: number;
  onProgress?: (fraction: number) => void;
}

/** §5.6 step 7 encoder settings. Loudnorm and platform transcodes run afterwards in ffmpeg. */
export async function renderVideo(input: RenderVideoInput): Promise<{ durationInFrames: number; fps: number }> {
  const serveUrl = await getBundle();
  const composition = await selectComposition({ serveUrl, id: input.compositionId, inputProps: input.inputProps });
  await renderMedia({
    serveUrl,
    composition,
    inputProps: input.inputProps,
    codec: "h264",
    crf: 18,
    x264Preset: "veryfast",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    concurrency: input.concurrency,
    outputLocation: input.outputLocation,
    onProgress: ({ progress }) => input.onProgress?.(progress),
  });
  return { durationInFrames: composition.durationInFrames, fps: composition.fps };
}
