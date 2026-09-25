import { describe, expect, it } from "vitest";
import { probeContainer, probeUploadedRecording } from "./probe-lite.ts";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, ...body: number[][]) => {
  const flat = body.flat();
  return [...be32(8 + flat.length), ...ascii(type), ...flat];
};
const zeros = (n: number) => new Array<number>(n).fill(0);

function mp4(opts: { w: number; h: number; timescale: number; duration: number; faststart: boolean; video?: boolean }): Uint8Array {
  const mvhd = box("mvhd", [0, 0, 0, 0], zeros(8), be32(opts.timescale), be32(opts.duration), zeros(80));
  const tkhd = box("tkhd", [0, 0, 0, 0], zeros(72), be32(opts.w * 65536), be32(opts.h * 65536));
  const hdlr = box("hdlr", zeros(8), ascii(opts.video === false ? "soun" : "vide"), zeros(12));
  const stsd = box("stsd", zeros(8), be32(16), ascii("avc1"), zeros(8));
  const trak = box("trak", tkhd, box("mdia", hdlr, box("minf", box("stbl", stsd))));
  const moov = box("moov", mvhd, trak);
  const mdat = box("mdat", zeros(16));
  const ftyp = box("ftyp", ascii("isom"), zeros(4));
  return new Uint8Array(opts.faststart ? [...ftyp, ...moov, ...mdat] : [...ftyp, ...mdat, ...moov]);
}

describe("header-only probe", () => {
  it("reads MP4 length, size, codec and faststart", () => {
    const p = probeContainer(mp4({ w: 1080, h: 1920, timescale: 1000, duration: 12_500, faststart: true }))!;
    expect(p.durationMs).toBe(12_500);
    expect(p.video).toMatchObject({ width: 1080, height: 1920, codec: "avc1" });
    expect(p.faststart).toBe(true);
    expect(probeContainer(mp4({ w: 640, h: 360, timescale: 600, duration: 1200, faststart: false }))!.faststart).toBe(false);
  });

  it("reads a WebM header", () => {
    const el = (id: number[], body: number[]) => [...id, 0x80 | body.length, ...body];
    const dur = [...new Uint8Array(new Float64Array([4200]).buffer)].reverse();
    const info = el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...el([0x44, 0x89], dur)]);
    const video = el([0xe0], [...el([0xb0], [0x05, 0x00]), ...el([0xba], [0x02, 0xd0])]);
    const entry = el([0xae], [...el([0x83], [1]), ...el([0x86], ascii("V_VP9")), ...video]);
    const tracks = el([0x16, 0x54, 0xae, 0x6b], entry);
    // Segment with an "unknown" size, as screen recorders write it.
    const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info, ...tracks];
    const bytes = new Uint8Array([...el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii("webm"))), ...segment]);
    const p = probeContainer(bytes)!;
    expect(p.durationMs).toBe(4200);
    expect(p.video).toMatchObject({ codec: "V_VP9", width: 1280, height: 720 });
  });

  it("refuses unreadable files and recordings with no video in plain words", () => {
    expect(() => probeUploadedRecording(new Uint8Array(64))).toThrow(/Export it again as MP4/);
    expect(() => probeUploadedRecording(mp4({ w: 0, h: 0, timescale: 1000, duration: 1000, faststart: true, video: false }))).toThrow(/no video track/);
    expect(() => probeUploadedRecording(mp4({ w: 10, h: 10, timescale: 1000, duration: 0, faststart: true }))).toThrow(/how long/);
  });
});
