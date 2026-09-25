import { describe, expect, it } from "vitest";
import { parseEbur128, parseLoudnormJson, parseProbe, parseRate } from "./parse.ts";

// Trimmed real ffmpeg 5.1 output shapes.
const LOUDNORM_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':
  Duration: 00:00:30.03, start: 0.000000, bitrate: 9876 kb/s
[Parsed_loudnorm_0 @ 0x55d5c7a3c880]
{
	"input_i" : "-20.51",
	"input_tp" : "-3.20",
	"input_lra" : "6.10",
	"input_thresh" : "-30.90",
	"output_i" : "-14.02",
	"output_tp" : "-1.50",
	"output_lra" : "5.20",
	"output_thresh" : "-24.40",
	"normalization_type" : "dynamic",
	"target_offset" : "0.02"
}
`;

const EBUR128_STDERR = `[Parsed_ebur128_0 @ 0x5581] t: 29.9     TARGET:-23 LUFS    M: -14.1 S: -13.9     I: -14.0 LUFS       LRA:   5.1 LU  FTPK: -2.1 -2.3 dBFS  TPK: -1.6 -1.7 dBFS
[Parsed_ebur128_0 @ 0x5581] Summary:

  Integrated loudness:
    I:         -14.1 LUFS
    Threshold: -24.4 LUFS

  Loudness range:
    LRA:         5.2 LU
    Threshold: -34.4 LUFS
    LRA low:   -18.6 LUFS
    LRA high:  -13.4 LUFS

  True peak:
    Peak:       -1.6 dBFS
`;

describe("parseLoudnormJson", () => {
  it("reads the pass-1 block", () => {
    expect(parseLoudnormJson(LOUDNORM_STDERR)).toEqual({ inputI: -20.51, inputTp: -3.2, inputLra: 6.1, inputThresh: -30.9, targetOffset: 0.02 });
  });
  it("uses the last block when ffmpeg prints more than one", () => {
    const twice = LOUDNORM_STDERR.replace('"-20.51"', '"-99"') + LOUDNORM_STDERR;
    expect(parseLoudnormJson(twice)?.inputI).toBe(-20.51);
  });
  it("returns null for silence", () => {
    const silent = LOUDNORM_STDERR.replace('"-20.51"', '"-inf"').replace('"-3.20"', '"-inf"').replace('"-30.90"', '"-inf"').replace('"0.02"', '"inf"');
    expect(parseLoudnormJson(silent)).toBeNull();
  });
  it("throws when there is no measurement", () => {
    expect(() => parseLoudnormJson("no json here")).toThrow();
    expect(() => parseLoudnormJson('{ "foo": "1" }')).toThrow();
  });
});

describe("parseEbur128", () => {
  it("reads integrated loudness, true peak and range from the summary", () => {
    expect(parseEbur128(EBUR128_STDERR)).toEqual({ lufs: -14.1, truePeak: -1.6, lra: 5.2 });
  });
  it("throws without a summary", () => {
    expect(() => parseEbur128("nothing")).toThrow();
  });
});

describe("parseProbe", () => {
  const json = JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", profile: "High", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1", avg_frame_rate: "30/1", bit_rate: "9800000", nb_frames: "900" },
      { codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2, bit_rate: "191000" },
    ],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "30.033333", size: "37000000", bit_rate: "9856000" },
  });
  it("maps streams and format", () => {
    expect(parseProbe(json, true)).toEqual({
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      durationMs: 30033,
      sizeBytes: 37_000_000,
      bitRate: 9_856_000,
      faststart: true,
      video: { codec: "h264", profile: "High", width: 1080, height: 1920, pixFmt: "yuv420p", fps: 30, cfr: true, bitRate: 9_800_000, frames: 900 },
      audio: { codec: "aac", profile: "LC", sampleRate: 48000, channels: 2, bitRate: 191_000 },
    });
  });
  it("flags VFR and missing tracks", () => {
    const vfr = JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", r_frame_rate: "60/1", avg_frame_rate: "2997/100" }], format: {} });
    const p = parseProbe(vfr);
    expect(p.video?.cfr).toBe(false);
    expect(p.video?.fps).toBeCloseTo(29.97);
    expect(p.audio).toBeNull();
    expect(p.faststart).toBeNull();
  });
  it("parses rates", () => {
    expect(parseRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseRate("0/0")).toBe(0);
    expect(parseRate(undefined)).toBe(0);
  });
});
