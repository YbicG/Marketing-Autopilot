import { describe, expect, it } from "vitest";
import type { ProbeInfo } from "@mkt/contracts";
import { checkAgainstPlatform } from "./platform-specs.ts";

const MB = 1024 * 1024;

const master = (over: Partial<ProbeInfo> = {}, v: Partial<NonNullable<ProbeInfo["video"]>> = {}, a: Partial<NonNullable<ProbeInfo["audio"]>> = {}): ProbeInfo => ({
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  durationMs: 30_000,
  sizeBytes: 38 * MB,
  bitRate: 10_000_000,
  faststart: true,
  video: { codec: "h264", profile: "High", width: 1080, height: 1920, pixFmt: "yuv420p", fps: 30, cfr: true, bitRate: 9_800_000, frames: 900, ...v },
  audio: { codec: "aac", profile: "LC", sampleRate: 48000, channels: 2, bitRate: 128_000, ...a },
  ...over,
});

const codes = (p: ProbeInfo, platform: Parameters<typeof checkAgainstPlatform>[1], opts?: Parameters<typeof checkAgainstPlatform>[2]) =>
  checkAgainstPlatform(p, platform, opts).map((i) => `${i.severity}:${i.code}`);

describe("checkAgainstPlatform", () => {
  it("a spec master passes everywhere", () => {
    for (const p of ["master", "tiktok", "ig_reel", "yt_short"] as const) expect(codes(master(), p)).toEqual([]);
  });

  it("master: exact size, H.264 High, yuv420p, 30 fps CFR, AAC-LC 48 kHz, faststart", () => {
    expect(codes(master({}, { width: 720, height: 1280 }), "master")).toContain("block:size");
    expect(codes(master({}, { profile: "Main" }), "master")).toContain("block:video_profile");
    expect(codes(master({}, { codec: "hevc" }), "master")).toContain("block:video_codec");
    expect(codes(master({}, { pixFmt: "yuv444p" }), "master")).toContain("block:pixel_format");
    expect(codes(master({}, { fps: 29.97 }), "master")).toContain("block:fps");
    expect(codes(master({}, { cfr: false }), "master")).toContain("block:vfr");
    expect(codes(master({}, {}, { sampleRate: 44100 }), "master")).toContain("block:sample_rate");
    expect(codes(master({}, {}, { profile: "HE-AAC" }), "master")).toContain("block:audio_profile");
    expect(codes(master({ faststart: false }), "master")).toContain("block:faststart");
    expect(codes(master({ audio: null }), "master")).toContain("block:no_audio");
  });

  it("master of another aspect uses the expected size", () => {
    expect(codes(master({}, { width: 1080, height: 1080 }), "master", { expectedSize: { width: 1080, height: 1080 } })).toEqual([]);
  });

  it("Reels: ≤300 MB, 3 s–15 min, 128k audio", () => {
    expect(codes(master({ sizeBytes: 301 * MB }), "ig_reel")).toContain("block:file_size");
    expect(codes(master({ durationMs: 2000 }), "ig_reel")).toContain("block:too_short");
    expect(codes(master({}, {}, { bitRate: 192_000 }), "ig_reel")).toContain("warn:audio_bitrate");
  });

  it("Shorts: ≤3 min", () => {
    expect(codes(master({ durationMs: 181_000 }), "yt_short")).toContain("block:too_long");
  });

  it("X: ≤140 s, ≤512 MB, vertical capped at 1200×1900", () => {
    expect(codes(master(), "x")).toContain("block:size");
    expect(codes(master({}, { width: 720, height: 1280 }), "x")).toEqual([]);
    expect(codes(master({ durationMs: 141_000 }, { width: 720, height: 1280 }), "x")).toContain("block:too_long");
    expect(codes(master({ sizeBytes: 513 * MB }, { width: 720, height: 1280 }), "x")).toContain("block:file_size");
  });

  it("warns when faststart couldn't be checked", () => {
    expect(codes(master({ faststart: null }), "tiktok")).toContain("warn:faststart_unknown");
  });
});
