import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ProbeInfo } from "@mkt/contracts";
import { isFaststart } from "../mp4.ts";
import {
  MASTER_FPS,
  VARIANTS,
  buildConcatList,
  cfrTiming,
  contactSheetArgs,
  ebur128Args,
  framesToCfrArgs,
  loudnormPass1Args,
  loudnormPass2Args,
  probeArgs,
  transcodeVariantArgs,
  variantFileName,
  type LoudnormMeasured,
  type TimedFrame,
  type Variant,
} from "./args.ts";
import { tools, type FfTools } from "./exec.ts";
import { parseEbur128, parseLoudnormJson, parseProbe, type Loudness } from "./parse.ts";

// ffmpeg/ffprobe runners (worker only). Every argv comes from ./args.ts.

export async function ffprobe(path: string, t: FfTools = {}): Promise<ProbeInfo> {
  const { ffprobe: bin, run } = tools(t);
  const { stdout } = await run(bin, probeArgs(path));
  const ext = extname(path).toLowerCase();
  const faststart = ext === ".mp4" || ext === ".mov" || ext === ".m4v" ? await isFaststart(path) : null;
  return parseProbe(stdout, faststart);
}

/**
 * Two-pass loudnorm to −14 LUFS / −1.5 dBTP, re-encoding the Remotion output into the master
 * (GOP 15, 2 B-frames, faststart). Returns the pass-1 measurement (null when silent / no audio).
 */
export async function loudnormTwoPass(input: string, output: string, t: FfTools = {}): Promise<{ measured: LoudnormMeasured | null }> {
  const { ffmpeg, run } = tools(t);
  const probe = await ffprobe(input, t);
  let measured: LoudnormMeasured | null = null;
  if (probe.audio) {
    const { stderr } = await run(ffmpeg, loudnormPass1Args(input));
    measured = parseLoudnormJson(stderr);
  }
  await run(ffmpeg, loudnormPass2Args(input, output, measured));
  return { measured };
}

export type VariantPaths = Record<Variant, string>;

/** tiktok / ig_reel / yt_short / x MP4s and a 540 WebP thumbnail next to each other in outDir. */
export async function transcodeVariants(master: string, outDir: string, t: FfTools & { thumbAtMs?: number } = {}): Promise<VariantPaths> {
  const { ffmpeg, run } = tools(t);
  await mkdir(outDir, { recursive: true });
  const base = basename(master, extname(master));
  const out = {} as VariantPaths;
  for (const v of VARIANTS) {
    const path = join(outDir, variantFileName(base, v));
    await run(ffmpeg, transcodeVariantArgs(master, path, v, t.thumbAtMs !== undefined ? { thumbAtMs: t.thumbAtMs } : {}));
    out[v] = path;
  }
  return out;
}

/** 3×3 contact sheet JPEG for QA vision. */
export async function contactSheet(master: string, out: string, t: FfTools = {}): Promise<{ path: string }> {
  const { ffmpeg, run } = tools(t);
  const probe = await ffprobe(master, t);
  await run(ffmpeg, contactSheetArgs(master, out, { durationMs: probe.durationMs, fps: probe.video?.fps || MASTER_FPS }));
  return { path: out };
}

export async function measureLoudness(path: string, t: FfTools = {}): Promise<Loudness> {
  const { ffmpeg, run } = tools(t);
  const { stderr } = await run(ffmpeg, ebur128Args(path));
  return parseEbur128(stderr);
}

/** Screencast JPEG frames with timestamps → CFR H.264 (M3b). */
export async function framesToCfr(
  opts: { frames: TimedFrame[]; fps?: number; out: string } & FfTools,
): Promise<{ path: string; durationMs: number; frameCount: number }> {
  const { ffmpeg, run } = tools(opts);
  const fps = opts.fps ?? MASTER_FPS;
  const list = `${opts.out}.ffconcat`;
  await writeFile(list, buildConcatList(opts.frames, fps), "utf8");
  try {
    await run(ffmpeg, framesToCfrArgs(list, opts.out, fps));
  } finally {
    await rm(list, { force: true });
  }
  const { totalMs, frameCount } = cfrTiming(opts.frames, fps);
  return { path: opts.out, durationMs: totalMs, frameCount };
}

export * from "./args.ts";
export * from "./parse.ts";
export * from "./exec.ts";
