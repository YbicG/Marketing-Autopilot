import type { ProbeInfo, SpecIssue } from "@mkt/contracts";

// §5.6 step 8 master spec and per-platform upload limits (§5.7 stage 0 "ffprobe against the
// platform spec table"). Limits as published by each platform in 2026; recheck on changes.

export type VideoPlatform = "master" | "tiktok" | "ig_reel" | "yt_short" | "x";

export type PlatformVideoSpec = {
  label: string;
  /** Exact size required (master) — otherwise only the max box applies. */
  size?: { width: number; height: number };
  /** Allowed boxes (either orientation listed explicitly). */
  maxBoxes?: { width: number; height: number }[];
  videoCodec: "h264";
  profiles?: string[];
  pixFmt: "yuv420p";
  /** Exact fps (master) or an allowed range. */
  fps: { exact?: number; min?: number; max?: number };
  cfr: boolean;
  audioCodec: "aac";
  audioProfile: "LC";
  sampleRate: number;
  maxAudioBitRate?: number;
  faststart: boolean;
  maxBytes?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLATFORM_SPECS: Record<VideoPlatform, PlatformVideoSpec> = {
  master: {
    label: "Master file",
    size: { width: 1080, height: 1920 },
    videoCodec: "h264",
    profiles: ["High"],
    pixFmt: "yuv420p",
    fps: { exact: 30 },
    cfr: true,
    audioCodec: "aac",
    audioProfile: "LC",
    sampleRate: 48000,
    faststart: true,
  },
  tiktok: {
    label: "TikTok",
    maxBoxes: [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }],
    videoCodec: "h264",
    pixFmt: "yuv420p",
    fps: { min: 23, max: 60 },
    cfr: true,
    audioCodec: "aac",
    audioProfile: "LC",
    sampleRate: 48000,
    faststart: true,
    maxBytes: 4 * GB,
    minDurationMs: 3000,
    maxDurationMs: 10 * 60_000,
  },
  ig_reel: {
    label: "Instagram Reels",
    maxBoxes: [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }],
    videoCodec: "h264",
    pixFmt: "yuv420p",
    fps: { min: 23, max: 60 },
    cfr: true,
    audioCodec: "aac",
    audioProfile: "LC",
    sampleRate: 48000,
    maxAudioBitRate: 128_000,
    faststart: true,
    maxBytes: 300 * MB,
    minDurationMs: 3000,
    maxDurationMs: 15 * 60_000,
  },
  yt_short: {
    label: "YouTube Shorts",
    maxBoxes: [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }],
    videoCodec: "h264",
    pixFmt: "yuv420p",
    fps: { min: 24, max: 60 },
    cfr: true,
    audioCodec: "aac",
    audioProfile: "LC",
    sampleRate: 48000,
    faststart: true,
    maxDurationMs: 3 * 60_000,
  },
  x: {
    label: "X",
    maxBoxes: [{ width: 1920, height: 1200 }, { width: 1200, height: 1900 }],
    videoCodec: "h264",
    profiles: ["High", "Main", "Constrained Baseline", "Baseline"],
    pixFmt: "yuv420p",
    fps: { max: 60 },
    cfr: false,
    audioCodec: "aac",
    audioProfile: "LC",
    sampleRate: 48000,
    faststart: true,
    maxBytes: 512 * MB,
    minDurationMs: 500,
    maxDurationMs: 140_000,
  },
};

/** ffprobe result against a platform's table row. Hard limits block; soft ones warn. */
export function checkAgainstPlatform(
  probe: ProbeInfo,
  platform: VideoPlatform,
  opts: { expectedSize?: { width: number; height: number } } = {},
): SpecIssue[] {
  const spec = PLATFORM_SPECS[platform];
  const issues: SpecIssue[] = [];
  const block = (code: string, message: string) => issues.push({ code, message: `${spec.label}: ${message}`, severity: "block" });
  const warn = (code: string, message: string) => issues.push({ code, message: `${spec.label}: ${message}`, severity: "warn" });

  const v = probe.video;
  if (!v) block("no_video", "the file has no video track");
  else {
    if (v.codec !== spec.videoCodec) block("video_codec", `video is ${v.codec}, needs H.264`);
    if (spec.profiles && v.profile && !spec.profiles.includes(v.profile)) block("video_profile", `H.264 profile is ${v.profile}, needs ${spec.profiles.join(" or ")}`);
    if (v.pixFmt !== spec.pixFmt) block("pixel_format", `pixel format is ${v.pixFmt ?? "unknown"}, needs yuv420p`);
    const size = opts.expectedSize ?? spec.size;
    if (size && (v.width !== size.width || v.height !== size.height)) block("size", `${v.width}×${v.height}, needs ${size.width}×${size.height}`);
    if (spec.maxBoxes && !spec.maxBoxes.some((b) => v.width <= b.width && v.height <= b.height)) {
      block("size", `${v.width}×${v.height} is larger than allowed`);
    }
    if (spec.fps.exact !== undefined && Math.abs(v.fps - spec.fps.exact) > 0.01) block("fps", `${v.fps.toFixed(2)} fps, needs ${spec.fps.exact}`);
    if (spec.fps.min !== undefined && v.fps < spec.fps.min - 0.01) block("fps", `${v.fps.toFixed(2)} fps is below ${spec.fps.min}`);
    if (spec.fps.max !== undefined && v.fps > spec.fps.max + 0.01) block("fps", `${v.fps.toFixed(2)} fps is above ${spec.fps.max}`);
    if (spec.cfr && !v.cfr) (platform === "master" ? block : warn)("vfr", "frame rate isn't constant");
  }

  const a = probe.audio;
  if (!a) block("no_audio", "the file has no audio track");
  else {
    if (a.codec !== spec.audioCodec) block("audio_codec", `audio is ${a.codec}, needs AAC`);
    if (a.profile && a.profile !== spec.audioProfile) block("audio_profile", `AAC profile is ${a.profile}, needs LC`);
    if (a.sampleRate !== spec.sampleRate) (platform === "master" ? block : warn)("sample_rate", `audio is ${a.sampleRate} Hz, expected ${spec.sampleRate}`);
    if (spec.maxAudioBitRate && a.bitRate && a.bitRate > spec.maxAudioBitRate * 1.05) {
      warn("audio_bitrate", `audio is ${Math.round(a.bitRate / 1000)} kbps; the limit is ${spec.maxAudioBitRate / 1000}`);
    }
  }

  if (spec.faststart && probe.faststart === false) block("faststart", "the index is at the end of the file (needs faststart)");
  if (spec.faststart && probe.faststart === null) warn("faststart_unknown", "couldn't check faststart");
  if (spec.maxBytes && probe.sizeBytes > spec.maxBytes) block("file_size", `${Math.round(probe.sizeBytes / MB)} MB is over ${Math.round(spec.maxBytes / MB)} MB`);
  if (spec.minDurationMs && probe.durationMs < spec.minDurationMs) block("too_short", `${(probe.durationMs / 1000).toFixed(1)} s is under ${spec.minDurationMs / 1000} s`);
  if (spec.maxDurationMs && probe.durationMs > spec.maxDurationMs) block("too_long", `${(probe.durationMs / 1000).toFixed(1)} s is over ${spec.maxDurationMs / 1000} s`);
  return issues;
}
