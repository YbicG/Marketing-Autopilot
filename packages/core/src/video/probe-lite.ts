// A header-only probe for uploaded recordings, for the web app: its image has no ffmpeg (§3.1), and
// ingestUpload only needs length and frame size. MP4/MOV (ISO BMFF: mvhd, tkhd, hdlr, stsd) and
// WebM/Matroska (EBML: Info, Tracks). The worker re-probes with real ffprobe before any render.

import type { ProbeInfo } from "@mkt/contracts";
import { UploadRejected } from "./uploads.ts";

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

interface Box {
  type: string;
  start: number;
  /** First byte after the header. */
  body: number;
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = fourcc(b, o + 4);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > to) return;
      size = u64(b, o + 8);
      body = o + 16;
    } else if (size === 0) size = to - o;
    if (size < body - o || o + size > to) return;
    yield { type, start: o, body, end: o + size };
    o += size;
  }
}

const child = (b: Uint8Array, parent: Box, type: string) => {
  for (const c of boxes(b, parent.body, parent.end)) if (c.type === type) return c;
  return null;
};

function probeIsoBmff(b: Uint8Array): ProbeInfo | null {
  let moov: Box | null = null;
  let mdatStart: number | null = null;
  for (const box of boxes(b, 0, b.length)) {
    if (box.type === "moov") moov = box;
    if (box.type === "mdat" && mdatStart === null) mdatStart = box.start;
  }
  if (!moov) return null;
  const mvhd = child(b, moov, "mvhd");
  if (!mvhd || mvhd.end - mvhd.body < 24) return null;
  const v1 = b[mvhd.body] === 1;
  const timescale = v1 ? u32(b, mvhd.body + 20) : u32(b, mvhd.body + 12);
  const duration = v1 ? u64(b, mvhd.body + 24) : u32(b, mvhd.body + 16);
  const durationMs = timescale > 0 ? Math.round((duration / timescale) * 1000) : 0;

  let video: ProbeInfo["video"] = null;
  for (const trak of boxes(b, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(b, trak, "mdia");
    const hdlr = mdia && child(b, mdia, "hdlr");
    if (!hdlr || hdlr.end - hdlr.body < 12 || fourcc(b, hdlr.body + 8) !== "vide") continue;
    const tkhd = child(b, trak, "tkhd");
    let width = 0;
    let height = 0;
    if (tkhd) {
      const off = tkhd.body + (b[tkhd.body] === 1 ? 88 : 76);
      if (off + 8 <= tkhd.end) {
        width = Math.round(u32(b, off) / 65536);
        height = Math.round(u32(b, off + 4) / 65536);
      }
    }
    const minf = child(b, mdia!, "minf");
    const stbl = minf && child(b, minf, "stbl");
    const stsd = stbl && child(b, stbl, "stsd");
    const codec = stsd && stsd.end - stsd.body >= 16 ? fourcc(b, stsd.body + 12).trim() : "unknown";
    video = { codec, profile: null, width, height, pixFmt: null, fps: 0, cfr: false, bitRate: null, frames: null };
    break;
  }
  return {
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    durationMs,
    sizeBytes: b.length,
    bitRate: null,
    faststart: mdatStart === null ? null : moov.start < mdatStart,
    video,
    audio: null,
  };
}

// ── EBML (WebM / Matroska) ──

const EBML_IDS = { segment: 0x18538067, info: 0x1549a966, timecodeScale: 0x2ad7b1, duration: 0x4489, tracks: 0x1654ae6b, trackEntry: 0xae, trackType: 0x83, codecId: 0x86, video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba, cluster: 0x1f43b675 };

function vint(b: Uint8Array, o: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  const first = b[o];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || o + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[o + i]!;
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

interface El {
  id: number;
  body: number;
  end: number;
}

function* elements(b: Uint8Array, from: number, to: number): Generator<El> {
  let o = from;
  while (o < to) {
    const id = vint(b, o, true);
    if (!id) return;
    const size = vint(b, o + id.len, false);
    if (!size) return;
    const body = o + id.len + size.len;
    const end = size.unknown ? to : Math.min(to, body + size.value);
    yield { id: id.value, body, end };
    o = end;
  }
}

const uint = (b: Uint8Array, e: El) => {
  let v = 0;
  for (let i = e.body; i < e.end; i++) v = v * 256 + b[i]!;
  return v;
};

function float(b: Uint8Array, e: El): number {
  const view = new DataView(b.buffer, b.byteOffset + e.body, e.end - e.body);
  if (e.end - e.body === 4) return view.getFloat32(0);
  if (e.end - e.body === 8) return view.getFloat64(0);
  return 0;
}

function probeEbml(b: Uint8Array): ProbeInfo | null {
  let segment: El | null = null;
  for (const e of elements(b, 0, b.length)) if (e.id === EBML_IDS.segment) segment = e;
  if (!segment) return null;
  let scale = 1_000_000;
  let duration = 0;
  let video: ProbeInfo["video"] = null;
  for (const e of elements(b, segment.body, segment.end)) {
    if (e.id === EBML_IDS.cluster) break; // headers come first; never walk the frames
    if (e.id === EBML_IDS.info) {
      for (const f of elements(b, e.body, e.end)) {
        if (f.id === EBML_IDS.timecodeScale) scale = uint(b, f) || scale;
        if (f.id === EBML_IDS.duration) duration = float(b, f);
      }
    }
    if (e.id === EBML_IDS.tracks && !video) {
      for (const t of elements(b, e.body, e.end)) {
        if (t.id !== EBML_IDS.trackEntry) continue;
        let type = 0;
        let codec = "unknown";
        let width = 0;
        let height = 0;
        for (const f of elements(b, t.body, t.end)) {
          if (f.id === EBML_IDS.trackType) type = uint(b, f);
          if (f.id === EBML_IDS.codecId) codec = new TextDecoder().decode(b.subarray(f.body, f.end)).replace(/\0+$/, "");
          if (f.id === EBML_IDS.video) {
            for (const g of elements(b, f.body, f.end)) {
              if (g.id === EBML_IDS.pixelWidth) width = uint(b, g);
              if (g.id === EBML_IDS.pixelHeight) height = uint(b, g);
            }
          }
        }
        if (type === 1) {
          video = { codec, profile: null, width, height, pixFmt: null, fps: 0, cfr: false, bitRate: null, frames: null };
          break;
        }
      }
    }
  }
  return {
    formatName: "matroska,webm",
    durationMs: Math.round((duration * scale) / 1_000_000),
    sizeBytes: b.length,
    bitRate: null,
    faststart: null,
    video,
    audio: null,
  };
}

/** Length and frame size from the container headers, or null when the file can't be read. */
export function probeContainer(bytes: Uint8Array): ProbeInfo | null {
  if (bytes.length < 12) return null;
  if (fourcc(bytes, 4) === "ftyp") return probeIsoBmff(bytes);
  if (u32(bytes, 0) === 0x1a45dfa3) return probeEbml(bytes);
  return null;
}

/** probeContainer for ingestUpload: a recording whose length we can't read is refused in plain words. */
export function probeUploadedRecording(bytes: Uint8Array): ProbeInfo {
  const p = probeContainer(bytes);
  if (!p) throw new UploadRejected("We couldn't read that recording. Export it again as MP4 and try again.");
  if (!p.video) throw new UploadRejected("That recording has no video track.");
  if (p.durationMs <= 0) {
    throw new UploadRejected(`That recording doesn't say how long it is${p.formatName.startsWith("matroska") ? " (common for WebM screen recordings)" : ""}. Export it as MP4 and try again.`);
  }
  return p;
}
