import { describe, expect, it } from "vitest";
import {
  buildConcatList,
  cfrFrameDurations,
  cfrTiming,
  contactSheetArgs,
  contactSheetFrames,
  ebur128Args,
  framesToCfrArgs,
  loudnormPass1Args,
  loudnormPass2Args,
  loudnormPass2Filter,
  probeArgs,
  transcodeVariantArgs,
  variantFileName,
} from "./args.ts";

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("probe / loudness args", () => {
  it("ffprobe asks for JSON streams and format", () => {
    expect(probeArgs("/m.mp4")).toEqual(["-v", "error", "-show_streams", "-show_format", "-of", "json", "/m.mp4"]);
  });
  it("pass 1 measures only", () => {
    const a = loudnormPass1Args("/in.mp4");
    expect(after(a, "-af")).toBe("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json");
    expect(a.slice(-3)).toEqual(["-f", "null", "-"]);
  });
  it("ebur128 prints true peak", () => {
    expect(after(ebur128Args("/x.mp4"), "-filter_complex")).toBe("ebur128=peak=true");
  });
});

describe("loudnorm pass 2", () => {
  const m = { inputI: -20.51, inputTp: -3.2, inputLra: 6.1, inputThresh: -30.9, targetOffset: 0.35 };
  it("feeds the pass-1 numbers back, linear", () => {
    expect(loudnormPass2Filter(m)).toBe(
      "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-20.51:measured_TP=-3.2:measured_LRA=6.1:measured_thresh=-30.9:offset=0.35:linear=true:print_format=summary",
    );
  });
  it("encodes the §5.6 master: High yuv420p 30 fps CFR, GOP 15, 2 B-frames, AAC-LC 48 kHz, faststart", () => {
    const a = loudnormPass2Args("/in.mp4", "/out.mp4", m);
    expect(after(a, "-c:v")).toBe("libx264");
    expect(after(a, "-profile:v")).toBe("high");
    expect(after(a, "-pix_fmt")).toBe("yuv420p");
    expect(after(a, "-r")).toBe("30");
    expect(after(a, "-fps_mode")).toBe("cfr");
    expect(after(a, "-g")).toBe("15");
    expect(after(a, "-bf")).toBe("2");
    expect(after(a, "-c:a")).toBe("aac");
    expect(after(a, "-profile:a")).toBe("aac_low");
    expect(after(a, "-ar")).toBe("48000");
    expect(after(a, "-movflags")).toBe("+faststart");
    expect(after(a, "-af")).toBe(loudnormPass2Filter(m));
    expect(a[a.length - 1]).toBe("/out.mp4");
  });
  it("adds a silent track when there is no audio to measure", () => {
    const a = loudnormPass2Args("/in.mp4", "/out.mp4", null);
    expect(a).toContain("anullsrc=r=48000:cl=stereo");
    expect(a).toContain("-shortest");
    expect(a).not.toContain("-af");
  });
});

describe("variants", () => {
  it("TikTok and Shorts remux the master", () => {
    for (const v of ["tiktok", "yt_short"] as const) {
      const a = transcodeVariantArgs("/m.mp4", "/o.mp4", v);
      expect(after(a, "-c")).toBe("copy");
      expect(after(a, "-movflags")).toBe("+faststart");
    }
  });
  it("Reels copies video and re-encodes audio to AAC 128k", () => {
    const a = transcodeVariantArgs("/m.mp4", "/o.mp4", "ig_reel");
    expect(after(a, "-c:v")).toBe("copy");
    expect(after(a, "-b:a")).toBe("128k");
    expect(after(a, "-ar")).toBe("48000");
  });
  it("X caps the long side at 1280", () => {
    const a = transcodeVariantArgs("/m.mp4", "/o.mp4", "x");
    expect(after(a, "-vf")).toBe("scale=-2:'min(1280,ih)':flags=lanczos");
    expect(after(a, "-b:a")).toBe("128k");
  });
  it("thumbnail is a 540-wide WebP at the given time", () => {
    const a = transcodeVariantArgs("/m.mp4", "/t.webp", "thumb", { thumbAtMs: 1500 });
    expect(after(a, "-ss")).toBe("1.500");
    expect(after(a, "-vf")).toBe("scale=540:-2:flags=lanczos");
    expect(after(a, "-c:v")).toBe("libwebp");
    expect(after(a, "-frames:v")).toBe("1");
  });
  it("names files", () => {
    expect(variantFileName("master", "ig_reel")).toBe("master.ig_reel.mp4");
    expect(variantFileName("master", "thumb")).toBe("master.thumb.webp");
  });
});

describe("contact sheet", () => {
  it("picks the middle of 9 equal slices", () => {
    expect(contactSheetFrames(9000, 30)).toEqual([15, 45, 75, 105, 135, 165, 195, 225, 255]);
  });
  it("selects those frames and tiles 3×3", () => {
    const a = contactSheetArgs("/m.mp4", "/s.jpg", { durationMs: 9000, fps: 30 });
    expect(after(a, "-vf")).toBe(
      "select='eq(n,15)+eq(n,45)+eq(n,75)+eq(n,105)+eq(n,135)+eq(n,165)+eq(n,195)+eq(n,225)+eq(n,255)',scale=360:-2,tile=3x3",
    );
    expect(after(a, "-frames:v")).toBe("1");
  });
  it("copes with very short clips", () => {
    expect(contactSheetFrames(100, 30)).toEqual([0, 1, 2]);
  });
});

describe("frames → CFR", () => {
  const frames = [
    { path: "/f/2.jpg", timestampMs: 1100 },
    { path: "/f/1.jpg", timestampMs: 1000 },
    { path: "/f/3.jpg", timestampMs: 1500 },
    { path: "/f/3b.jpg", timestampMs: 1500 },
  ];
  it("sorts, dedupes and gives each frame its display time", () => {
    const d = cfrFrameDurations(frames, 30);
    expect(d.map((x) => x.path)).toEqual(["/f/1.jpg", "/f/2.jpg", "/f/3b.jpg"]);
    expect(d[0]!.durationMs).toBe(100);
    expect(d[1]!.durationMs).toBe(400);
    expect(d[2]!.durationMs).toBeCloseTo(1000 / 30);
  });
  it("total length and CFR frame count", () => {
    const t = cfrTiming(frames, 30);
    expect(t.totalMs).toBeCloseTo(500 + 1000 / 30);
    expect(t.frameCount).toBe(16);
  });
  it("writes an ffconcat list with the last file repeated and quotes escaped", () => {
    const list = buildConcatList([...frames, { path: "/f/it's.jpg", timestampMs: 2000 }], 30);
    const lines = list.trim().split("\n");
    expect(lines[0]).toBe("ffconcat version 1.0");
    expect(lines[1]).toBe("file '/f/1.jpg'");
    expect(lines[2]).toBe("duration 0.100000");
    expect(lines[lines.length - 1]).toBe("file '/f/it'\\''s.jpg'");
    expect(lines[lines.length - 3]).toBe("file '/f/it'\\''s.jpg'");
    expect(() => buildConcatList([], 30)).toThrow();
  });
  it("encodes 30 fps CFR H.264", () => {
    const a = framesToCfrArgs("/l.ffconcat", "/o.mp4", 30);
    expect(after(a, "-f")).toBe("concat");
    expect(after(a, "-safe")).toBe("0");
    expect(after(a, "-vf")).toBe("fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p");
    expect(after(a, "-r")).toBe("30");
    expect(after(a, "-profile:v")).toBe("high");
  });
});
