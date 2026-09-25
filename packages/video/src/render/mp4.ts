import { open } from "node:fs/promises";

// Minimal ISO-BMFF (MP4) top-level box scanner: enough to check faststart (moov before mdat)
// and to place an XMP uuid box. Reads box headers only, never the media data.

export type Box = { type: string; offset: number; size: number; headerSize: number; usertype?: string };
export type ReadAt = (position: number, length: number) => Promise<Uint8Array>;

/** Adobe XMP uuid box usertype (BE7ACFCB-97A9-42E8-9C71-999491E3AFAC). */
export const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ascii = (b: Uint8Array) => String.fromCharCode(...b);

export async function scanTopLevelBoxes(read: ReadAt, fileSize: number): Promise<Box[]> {
  const boxes: Box[] = [];
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const h = await read(pos, Math.min(32, fileSize - pos));
    const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = view.getUint32(0);
    const type = ascii(h.subarray(4, 8));
    let headerSize = 8;
    if (size === 1) {
      if (h.byteLength < 16) break;
      size = Number(view.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < headerSize || pos + size > fileSize) throw new Error(`Malformed MP4 box "${type}" at ${pos}`);
    const box: Box = { type, offset: pos, size, headerSize };
    if (type === "uuid" && h.byteLength >= headerSize + 16) box.usertype = hex(h.subarray(headerSize, headerSize + 16));
    boxes.push(box);
    pos += size;
  }
  return boxes;
}

/** true when moov precedes mdat; null when either is missing (not an MP4). */
export function moovBeforeMdat(boxes: readonly Box[]): boolean | null {
  const moov = boxes.findIndex((b) => b.type === "moov");
  const mdat = boxes.findIndex((b) => b.type === "mdat");
  if (moov < 0 || mdat < 0) return null;
  return moov < mdat;
}

export const bufferReader =
  (buf: Uint8Array): ReadAt =>
  async (position, length) =>
    buf.subarray(position, position + length);

export async function withFileReader<T>(path: string, fn: (read: ReadAt, size: number) => Promise<T>): Promise<T> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const read: ReadAt = async (position, length) => {
      const b = Buffer.alloc(length);
      const { bytesRead } = await fh.read(b, 0, length, position);
      return b.subarray(0, bytesRead);
    };
    return await fn(read, size);
  } finally {
    await fh.close();
  }
}

export async function isFaststart(path: string): Promise<boolean | null> {
  try {
    return moovBeforeMdat(await withFileReader(path, scanTopLevelBoxes));
  } catch {
    return null;
  }
}
