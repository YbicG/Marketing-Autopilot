// ImageDecoder / ImageResizer over ffmpeg (already in the worker image), so the phash and PII-frame
// checks run without adding sharp's native binary. Pure argv builders are exported for tests.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageDecoder, ImageResizer } from "@mkt/core/video";
import { defaultRunner, ffprobe, type FfTools } from "@mkt/video/render";

/** Exact w×h, 8-bit gray, raw bytes (phash input). */
export function grayscaleArgs(input: string, output: string, width: number, height: number): string[] {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", output];
}

/** Fit inside maxW×maxH (never upscale), JPEG at an ffmpeg qscale mapped from 1–100 quality. */
export function toJpegArgs(input: string, output: string, maxW: number, maxH: number, quality = 85): string[] {
  const q = Math.min(31, Math.max(2, Math.round(2 + ((100 - quality) / 100) * 29)));
  const scale = `scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1", "-vf", scale, "-q:v", String(q), output];
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mkt-img-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function ffmpegImageTools(ff: FfTools = {}): { decoder: ImageDecoder; resizer: ImageResizer } {
  const bin = ff.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const run = ff.run ?? defaultRunner;
  return {
    decoder: {
      grayscale: (bytes, width, height) =>
        withTmp(async (dir) => {
          const src = join(dir, "in");
          const out = join(dir, "out.gray");
          await writeFile(src, bytes);
          await run(bin, grayscaleArgs(src, out, width, height));
          const gray = new Uint8Array(await readFile(out));
          if (gray.length !== width * height) throw new Error(`grayscale decode returned ${gray.length} bytes, expected ${width * height}`);
          return gray;
        }),
    },
    resizer: {
      toJpeg: (bytes, maxW, maxH, quality) =>
        withTmp(async (dir) => {
          const src = join(dir, "in");
          const out = join(dir, "out.jpg");
          await writeFile(src, bytes);
          const before = await ffprobe(src, ff);
          await run(bin, toJpegArgs(src, out, maxW, maxH, quality));
          const after = await ffprobe(out, ff);
          if (!before.video || !after.video) throw new Error("not an image");
          return { jpeg: new Uint8Array(await readFile(out)), width: after.video.width, height: after.video.height, srcWidth: before.video.width, srcHeight: before.video.height };
        }),
    },
  };
}
