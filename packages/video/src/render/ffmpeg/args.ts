// Pure ffmpeg/ffprobe argv builders (§5.6 steps 7–8, §5.7 stage 0). No I/O here, so every
// flag is unit-tested; ./index.ts runs them. Argv arrays go straight to execFile (no shell),
// so nothing is shell-quoted; filtergraph quoting is ffmpeg's own.

export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 } as const;
export const MASTER_FPS = 30;

export type LoudnormMeasured = {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
};

const loudnormBase = `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;

export function probeArgs(input: string): string[] {
  return ["-v", "error", "-show_streams", "-show_format", "-of", "json", input];
}

/** Pass 1: measure only; ffmpeg prints a JSON block on stderr. */
export function loudnormPass1Args(input: string): string[] {
  return ["-hide_banner", "-nostats", "-i", input, "-map", "0:a:0", "-af", `${loudnormBase}:print_format=json`, "-f", "null", "-"];
}

export function loudnormPass2Filter(m: LoudnormMeasured): string {
  return (
    `${loudnormBase}:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}` +
    `:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true:print_format=summary`
  );
}

/** §5.6 step 8 master video settings: H.264 High yuv420p, 30 fps CFR, GOP 15 with 2 B-frames, ~10 Mbps. */
export const MASTER_VIDEO_ARGS = [
  "-c:v", "libx264",
  "-profile:v", "high",
  "-pix_fmt", "yuv420p",
  "-preset", "medium",
  "-crf", "18",
  "-maxrate", "12M",
  "-bufsize", "24M",
  "-r", String(MASTER_FPS),
  "-fps_mode", "cfr",
  "-g", "15",
  "-bf", "2",
  "-sc_threshold", "0",
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
] as const;

const aac = (bitrate: string) => ["-c:a", "aac", "-profile:a", "aac_low", "-b:a", bitrate, "-ar", "48000", "-ac", "2"];

/**
 * Pass 2: re-encode the Remotion output into the master. With `measured` the audio is
 * loudness-normalised (linear); with null the input has no audio and a silent AAC track is added,
 * because some platforms reject video-only files.
 */
export function loudnormPass2Args(input: string, output: string, measured: LoudnormMeasured | null): string[] {
  const head = ["-hide_banner", "-nostats", "-y", "-i", input];
  if (!measured) {
    return [
      ...head,
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-map", "0:v:0", "-map", "1:a:0",
      ...MASTER_VIDEO_ARGS,
      ...aac("192k"),
      "-shortest",
      "-movflags", "+faststart",
      output,
    ];
  }
  return [
    ...head,
    "-map", "0:v:0", "-map", "0:a:0",
    ...MASTER_VIDEO_ARGS,
    "-af", loudnormPass2Filter(measured),
    ...aac("192k"),
    "-movflags", "+faststart",
    output,
  ];
}

export const VARIANTS = ["tiktok", "ig_reel", "yt_short", "x", "thumb"] as const;
export type Variant = (typeof VARIANTS)[number];

export const variantFileName = (base: string, v: Variant) => `${base}.${v}.${v === "thumb" ? "webp" : "mp4"}`;

/**
 * Platform variants from our own master (§5.6 step 7). TikTok and Shorts take the master as is
 * (a remux keeps faststart); Reels wants AAC 128k; X caps the long side (1920×1200 / 1200×1900),
 * so vertical goes to 720×1280; the thumbnail is a 540-wide WebP.
 */
export function transcodeVariantArgs(master: string, output: string, variant: Variant, opts: { thumbAtMs?: number } = {}): string[] {
  const head = ["-hide_banner", "-nostats", "-y"];
  switch (variant) {
    case "tiktok":
    case "yt_short":
      return [...head, "-i", master, "-map", "0", "-c", "copy", "-movflags", "+faststart", output];
    case "ig_reel":
      return [...head, "-i", master, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", ...aac("128k"), "-movflags", "+faststart", output];
    case "x":
      return [
        ...head, "-i", master,
        "-map", "0:v:0", "-map", "0:a:0",
        "-vf", "scale=-2:'min(1280,ih)':flags=lanczos",
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "medium",
        "-crf", "20", "-maxrate", "8M", "-bufsize", "16M",
        "-r", String(MASTER_FPS), "-fps_mode", "cfr", "-g", "30", "-bf", "2",
        ...aac("128k"),
        "-movflags", "+faststart",
        output,
      ];
    case "thumb":
      return [
        ...head,
        "-ss", ((opts.thumbAtMs ?? 1000) / 1000).toFixed(3),
        "-i", master,
        "-frames:v", "1",
        "-vf", "scale=540:-2:flags=lanczos",
        "-c:v", "libwebp", "-quality", "82",
        output,
      ];
  }
}

/** Frame numbers for an n×n contact sheet: the middle of each of n² equal slices. */
export function contactSheetFrames(durationMs: number, fps: number, grid = 3): number[] {
  const count = grid * grid;
  const total = Math.max(1, Math.floor((durationMs * fps) / 1000));
  const frames = Array.from({ length: count }, (_, i) => Math.min(total - 1, Math.floor(((i + 0.5) * total) / count)));
  return [...new Set(frames)];
}

/** 3×3 contact sheet for QA vision (§5.7 stage 2): select 9 frames, tile them into one JPEG. */
export function contactSheetArgs(master: string, output: string, opts: { durationMs: number; fps: number; grid?: number; tileWidth?: number }): string[] {
  const grid = opts.grid ?? 3;
  const select = contactSheetFrames(opts.durationMs, opts.fps, grid).map((n) => `eq(n,${n})`).join("+");
  return [
    "-hide_banner", "-nostats", "-y",
    "-i", master,
    "-vf", `select='${select}',scale=${opts.tileWidth ?? 360}:-2,tile=${grid}x${grid}`,
    "-frames:v", "1",
    "-fps_mode", "vfr",
    "-q:v", "3",
    output,
  ];
}

/** EBU R128 measurement (§5.7 stage 0 loudness): summary on stderr. */
export function ebur128Args(input: string): string[] {
  return ["-hide_banner", "-nostats", "-i", input, "-map", "0:a:0", "-filter_complex", "ebur128=peak=true", "-f", "null", "-"];
}

// ── Screencast frames → CFR video (M3b cfr.ts) ──

export type TimedFrame = { path: string; timestampMs: number };

/** Frames in time order, one per timestamp (later file wins), with per-frame display durations. */
export function cfrFrameDurations(frames: readonly TimedFrame[], fps: number): { path: string; durationMs: number }[] {
  const sorted = [...frames].sort((a, b) => a.timestampMs - b.timestampMs);
  const dedup: TimedFrame[] = [];
  for (const f of sorted) {
    const last = dedup[dedup.length - 1];
    if (last && last.timestampMs === f.timestampMs) dedup[dedup.length - 1] = f;
    else dedup.push(f);
  }
  const frameMs = 1000 / fps;
  return dedup.map((f, i) => ({ path: f.path, durationMs: i + 1 < dedup.length ? dedup[i + 1]!.timestampMs - f.timestampMs : frameMs }));
}

/** Output length and CFR frame count for a screencast. */
export function cfrTiming(frames: readonly TimedFrame[], fps: number): { totalMs: number; frameCount: number } {
  const totalMs = cfrFrameDurations(frames, fps).reduce((s, f) => s + f.durationMs, 0);
  return { totalMs, frameCount: Math.round((totalMs * fps) / 1000) };
}

const concatQuote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;

/**
 * ffconcat list with each frame's own duration. The last file is listed twice: the concat demuxer
 * ignores the final entry's duration otherwise.
 */
export function buildConcatList(frames: readonly TimedFrame[], fps: number): string {
  const items = cfrFrameDurations(frames, fps);
  if (items.length === 0) throw new Error("No frames to encode");
  const lines = ["ffconcat version 1.0"];
  for (const f of items) lines.push(`file ${concatQuote(f.path)}`, `duration ${(f.durationMs / 1000).toFixed(6)}`);
  lines.push(`file ${concatQuote(items[items.length - 1]!.path)}`);
  return `${lines.join("\n")}\n`;
}

/** The concat list (variable frame times) re-timed to fps CFR H.264. */
export function framesToCfrArgs(listPath: string, output: string, fps: number): string[] {
  return [
    "-hide_banner", "-nostats", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "18",
    "-r", String(fps), "-fps_mode", "cfr", "-g", "15", "-bf", "2",
    "-an",
    "-movflags", "+faststart",
    output,
  ];
}
