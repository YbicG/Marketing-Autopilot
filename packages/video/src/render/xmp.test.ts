import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XMP_UUID, bufferReader, moovBeforeMdat, scanTopLevelBoxes } from "./mp4.ts";
import { buildXmpPacket, digitalSourceTypeForTier, digitalSourceTypeUri, injectJpegXmp, mp4XmpBox, planMp4Xmp, writeXmp } from "./xmp.ts";

const box = (type: string, payload: Uint8Array = new Uint8Array(4)) => {
  const b = new Uint8Array(8 + payload.length);
  new DataView(b.buffer).setUint32(0, b.length);
  b.set(new TextEncoder().encode(type), 4);
  b.set(payload, 8);
  return b;
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const fastMp4 = () => concat(box("ftyp", new Uint8Array(8)), box("moov", new Uint8Array(16)), box("mdat", new Uint8Array(64)));
const slowMp4 = () => concat(box("ftyp", new Uint8Array(8)), box("mdat", new Uint8Array(64)), box("moov", new Uint8Array(16)));
const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

const DST = digitalSourceTypeUri("composite");

describe("MP4 box scan", () => {
  it("finds top-level boxes and faststart order", async () => {
    const fast = await scanTopLevelBoxes(bufferReader(fastMp4()), fastMp4().length);
    expect(fast.map((b) => b.type)).toEqual(["ftyp", "moov", "mdat"]);
    expect(moovBeforeMdat(fast)).toBe(true);
    expect(moovBeforeMdat(await scanTopLevelBoxes(bufferReader(slowMp4()), slowMp4().length))).toBe(false);
    expect(moovBeforeMdat([{ type: "ftyp", offset: 0, size: 8, headerSize: 8 }])).toBeNull();
  });
  it("rejects a box that runs past the end", async () => {
    const bad = fastMp4().slice(0, 30);
    await expect(scanTopLevelBoxes(bufferReader(bad), bad.length)).rejects.toThrow();
  });
  it("reads the XMP uuid usertype", async () => {
    const f = concat(fastMp4(), mp4XmpBox("<x/>"));
    const boxes = await scanTopLevelBoxes(bufferReader(f), f.length);
    expect(boxes[3]).toMatchObject({ type: "uuid", usertype: XMP_UUID });
  });
});

describe("XMP packet", () => {
  it("carries the IPTC digital source type", () => {
    const x = buildXmpPacket({ digitalSourceType: DST });
    expect(x).toContain('xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"');
    expect(x).toContain(`Iptc4xmpExt:DigitalSourceType="${DST}"`);
    expect(x.startsWith("<?xpacket begin=")).toBe(true);
  });
  it("maps provenance tiers", () => {
    expect(digitalSourceTypeForTier("A")).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/composite");
    expect(digitalSourceTypeForTier("B")).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia");
    expect(digitalSourceTypeForTier("C")).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
  });
});

describe("JPEG XMP", () => {
  const jfif = new Uint8Array([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]);
  const sos = new Uint8Array([0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x11, 0x22, 0xff, 0xd9]);
  const jpeg = concat(new Uint8Array([0xff, 0xd8]), jfif, sos);

  it("inserts APP1 after JFIF and keeps the image data", () => {
    const out = injectJpegXmp(jpeg, "<xmp/>");
    expect([...out.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.subarray(2, 2 + jfif.length)]).toEqual([...jfif]);
    const app1 = 2 + jfif.length;
    expect([out[app1], out[app1 + 1]]).toEqual([0xff, 0xe1]);
    const len = (out[app1 + 2]! << 8) | out[app1 + 3]!;
    expect(text(out.subarray(app1 + 4, app1 + 2 + len))).toBe("http://ns.adobe.com/xap/1.0/\0<xmp/>");
    expect([...out.subarray(out.length - sos.length)]).toEqual([...sos]);
  });
  it("replaces an existing XMP segment instead of stacking", () => {
    const twice = injectJpegXmp(injectJpegXmp(jpeg, "<old/>"), "<new/>");
    expect(text(twice)).toContain("<new/>");
    expect(text(twice)).not.toContain("<old/>");
  });
  it("rejects non-JPEG input", () => {
    expect(() => injectJpegXmp(new Uint8Array([1, 2, 3]), "x")).toThrow();
  });
});

describe("MP4 XMP plan", () => {
  it("cuts a trailing old XMP box and frees earlier ones", async () => {
    const f = concat(fastMp4(), mp4XmpBox("<a/>"), box("free"), mp4XmpBox("<b/>"));
    const boxes = await scanTopLevelBoxes(bufferReader(f), f.length);
    const plan = planMp4Xmp(boxes);
    expect(plan.truncateTo).toBe(boxes[5]!.offset);
    expect(plan.freeOffsets).toEqual([boxes[3]!.offset + 4]);
  });
  it("does nothing to a file without XMP", async () => {
    const f = fastMp4();
    expect(planMp4Xmp(await scanTopLevelBoxes(bufferReader(f), f.length))).toEqual({ freeOffsets: [], truncateTo: null });
  });
});

describe("writeXmp (native, temp files)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mkt-xmp-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends one XMP box to an MP4, keeps faststart, and replaces on rewrite", async () => {
    const p = join(dir, "a.mp4");
    const mp4 = concat(box("ftyp", new TextEncoder().encode("isom\0\0\0\0")), box("moov", new Uint8Array(16)), box("mdat", new Uint8Array(64)));
    await writeFile(p, mp4);
    expect(await writeXmp(p, DST)).toEqual({ method: "native", format: "mp4" });
    await writeXmp(p, digitalSourceTypeUri("compositeWithTrainedAlgorithmicMedia"));
    const out = new Uint8Array(await readFile(p));
    const boxes = await scanTopLevelBoxes(bufferReader(out), out.length);
    expect(boxes.map((b) => b.type)).toEqual(["ftyp", "moov", "mdat", "uuid"]);
    expect(moovBeforeMdat(boxes)).toBe(true);
    expect(text(out)).toContain("compositeWithTrainedAlgorithmicMedia");
    expect([...out.subarray(0, mp4.length)]).toEqual([...mp4]);
  });

  it("writes into a JPEG", async () => {
    const p = join(dir, "a.jpg");
    await writeFile(p, new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
    expect(await writeXmp(p, DST)).toEqual({ method: "native", format: "jpeg" });
    expect(text(new Uint8Array(await readFile(p)))).toContain(DST);
  });

  it("uses exiftool when given one", async () => {
    const p = join(dir, "b.jpg");
    await writeFile(p, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const calls: [string, readonly string[]][] = [];
    const run = async (bin: string, args: readonly string[]) => {
      calls.push([bin, args]);
      return { stdout: "", stderr: "" };
    };
    expect(await writeXmp(p, DST, { exiftoolPath: "/usr/bin/exiftool", run })).toEqual({ method: "exiftool", format: "jpeg" });
    expect(calls[0]![0]).toBe("/usr/bin/exiftool");
    expect(calls[0]![1]).toContain(`-XMP-iptcExt:DigitalSourceType=${DST}`);
  });

  it("refuses values that aren't IPTC codes", async () => {
    await expect(writeXmp(join(dir, "a.jpg"), "composite")).rejects.toThrow();
  });
});
