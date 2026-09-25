import { appendFile, open, readFile, truncate, writeFile } from "node:fs/promises";
import { XMP_UUID, scanTopLevelBoxes, withFileReader, type Box } from "./mp4.ts";
import { defaultRunner, type Runner } from "./ffmpeg/exec.ts";

// §5.6 step 7 / §8: IPTC digitalSourceType written into the file as the LAST change (after
// loudnorm and transcodes, which would drop it).
//
// How it's embedded:
// - exiftool, when the image has it (`exiftoolPath`): `-XMP-iptcExt:DigitalSourceType=<uri>`.
// - Otherwise natively, no extra binary:
//   - MP4/MOV: a top-level `uuid` box with the XMP usertype (BE7ACFCB-97A9-42E8-9C71-999491E3AFAC),
//     the same place exiftool writes it. It is appended at the end, so no chunk offsets move and
//     moov stays before mdat (faststart holds). An earlier XMP box is dropped or turned into `free`.
//   - JPEG: an APP1 segment "http://ns.adobe.com/xap/1.0/\0" + packet after APP0/Exif; an
//     existing XMP APP1 is replaced.
// ffmpeg can't write XMP (its -metadata goes into udta/ilst tags), so it is not used here.

export const DIGITAL_SOURCE_TYPE_BASE = "http://cv.iptc.org/newscodes/digitalsourcetype/";
export const DIGITAL_SOURCE_TYPES = [
  "digitalCapture",
  "screenCapture",
  "composite",
  "compositeCapture",
  "compositeSynthetic",
  "compositeWithTrainedAlgorithmicMedia",
  "trainedAlgorithmicMedia",
  "algorithmicMedia",
  "digitalArt",
] as const;
export type DigitalSourceTypeCode = (typeof DIGITAL_SOURCE_TYPES)[number];

export const digitalSourceTypeUri = (code: DigitalSourceTypeCode) => `${DIGITAL_SOURCE_TYPE_BASE}${code}`;

/**
 * Provenance tier (D18) → IPTC code for our rendered output: A = our composite of captured or
 * uploaded material; B = the same with TTS voice or checked AI images mixed in; C = generative.
 */
export function digitalSourceTypeForTier(tier: "A" | "B" | "C"): string {
  return digitalSourceTypeUri(tier === "A" ? "composite" : tier === "B" ? "compositeWithTrainedAlgorithmicMedia" : "trainedAlgorithmicMedia");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildXmpPacket(opts: { digitalSourceType: string; creatorTool?: string }): string {
  const tool = opts.creatorTool ?? "Marketing Autopilot";
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"',
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    ` Iptc4xmpExt:DigitalSourceType="${esc(opts.digitalSourceType)}"`,
    ` xmp:CreatorTool="${esc(tool)}"/>`,
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
}

const XMP_JPEG_HEADER = "http://ns.adobe.com/xap/1.0/\0";
const enc = new TextEncoder();

/** JPEG bytes with the XMP packet in an APP1 segment (replacing any existing XMP APP1). */
export function injectJpegXmp(jpeg: Uint8Array, xmp: string): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Not a JPEG");
  const payload = enc.encode(XMP_JPEG_HEADER + xmp);
  if (payload.length + 2 > 0xffff) throw new Error("XMP packet too large for one APP1 segment");
  const header = enc.encode(XMP_JPEG_HEADER);
  const isXmp = (seg: Uint8Array) => seg.length >= 4 + header.length && header.every((c, i) => seg[4 + i] === c);

  const kept: Uint8Array[] = [];
  let insertAt = 0;
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1]!;
    // Stop at start-of-scan or any non-APP marker: everything from here on is copied as is.
    if (marker < 0xe0 || marker > 0xef) break;
    const len = (jpeg[pos + 2]! << 8) | jpeg[pos + 3]!;
    const seg = jpeg.subarray(pos, pos + 2 + len);
    if (!(marker === 0xe1 && isXmp(seg))) {
      kept.push(seg);
      // New XMP goes after the leading APP0 (JFIF) and APP1 (Exif) segments.
      if (marker === 0xe0 || marker === 0xe1) insertAt = kept.length;
    }
    pos += 2 + len;
  }
  const app1 = new Uint8Array(4 + payload.length);
  app1.set([0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff]);
  app1.set(payload, 4);
  const parts = [jpeg.subarray(0, 2), ...kept.slice(0, insertAt), app1, ...kept.slice(insertAt), jpeg.subarray(pos)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A top-level MP4 `uuid` box holding the XMP packet. */
export function mp4XmpBox(xmp: string): Uint8Array {
  const payload = enc.encode(xmp);
  const size = 8 + 16 + payload.length;
  const box = new Uint8Array(size);
  new DataView(box.buffer).setUint32(0, size);
  box.set(enc.encode("uuid"), 4);
  box.set(
    XMP_UUID.match(/../g)!.map((h) => parseInt(h, 16)),
    8,
  );
  box.set(payload, 24);
  return box;
}

export type XmpResult = { method: "exiftool" | "native"; format: "mp4" | "jpeg" };

async function sniff(path: string): Promise<"mp4" | "jpeg"> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(12);
    await fh.read(b, 0, 12, 0);
    if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
    if (b.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
    throw new Error(`Can't write XMP into ${path}: not an MP4 or JPEG`);
  } finally {
    await fh.close();
  }
}

/** What to change in an MP4 before appending a fresh XMP box: old XMP boxes become `free`, or are cut if last. */
export function planMp4Xmp(boxes: readonly Box[]): { freeOffsets: number[]; truncateTo: number | null } {
  const old = boxes.filter((b) => b.type === "uuid" && b.usertype === XMP_UUID);
  const last = boxes[boxes.length - 1];
  const cutLast = last !== undefined && old.includes(last);
  return { freeOffsets: old.filter((b) => b !== last).map((b) => b.offset + 4), truncateTo: cutLast ? last.offset : null };
}

async function writeMp4Xmp(path: string, xmp: string): Promise<void> {
  const plan = planMp4Xmp(await withFileReader(path, scanTopLevelBoxes));
  if (plan.freeOffsets.length) {
    const fh = await open(path, "r+");
    try {
      for (const at of plan.freeOffsets) await fh.write(Buffer.from("free", "latin1"), 0, 4, at);
    } finally {
      await fh.close();
    }
  }
  if (plan.truncateTo !== null) await truncate(path, plan.truncateTo);
  await appendFile(path, mp4XmpBox(xmp));
}

/** Write the IPTC digitalSourceType into an MP4 or JPEG, in place. Call after every other edit. */
export async function writeXmp(
  path: string,
  digitalSourceType: string,
  opts: { exiftoolPath?: string | null; run?: Runner; creatorTool?: string } = {},
): Promise<XmpResult> {
  if (!digitalSourceType.startsWith(DIGITAL_SOURCE_TYPE_BASE)) throw new Error(`Not an IPTC digital source type: ${digitalSourceType}`);
  const format = await sniff(path);
  if (opts.exiftoolPath) {
    await (opts.run ?? defaultRunner)(opts.exiftoolPath, ["-overwrite_original", "-m", `-XMP-iptcExt:DigitalSourceType=${digitalSourceType}`, `-XMP-xmp:CreatorTool=${opts.creatorTool ?? "Marketing Autopilot"}`, path]);
    return { method: "exiftool", format };
  }
  const xmp = buildXmpPacket({ digitalSourceType, ...(opts.creatorTool ? { creatorTool: opts.creatorTool } : {}) });
  if (format === "jpeg") await writeFile(path, injectJpegXmp(await readFile(path), xmp));
  else await writeMp4Xmp(path, xmp);
  return { method: "native", format };
}
