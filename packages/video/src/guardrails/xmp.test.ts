// §8 "EU AI Act Art. 50": the IPTC digitalSourceType goes into every final JPEG and MP4 as an XMP
// packet. Here the native writer runs on real (tiny) files; no exiftool or ffmpeg. The pipeline
// side (called for every output, last) is in packages/core/src/guardrails/eu-ai-act.test.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DIGITAL_SOURCE_TYPE_BASE, digitalSourceTypeForTier, writeXmp } from "../render/xmp.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mkt-xmp-guard-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const box = (type: string, payload: number) => {
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, b.length);
  b.set(new TextEncoder().encode(type), 4);
  return b;
};
const tinyMp4 = () => Buffer.concat([box("ftyp", 8), box("moov", 16), box("mdat", 64)]);
// SOI, APP0 (JFIF), EOI: enough for the segment writer.
const tinyJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

describe("§8 XMP digitalSourceType", () => {
  it("tiers map to IPTC codes", () => {
    expect(digitalSourceTypeForTier("A")).toBe(`${DIGITAL_SOURCE_TYPE_BASE}composite`);
    expect(digitalSourceTypeForTier("B")).toBe(`${DIGITAL_SOURCE_TYPE_BASE}compositeWithTrainedAlgorithmicMedia`);
    expect(digitalSourceTypeForTier("C")).toBe(`${DIGITAL_SOURCE_TYPE_BASE}trainedAlgorithmicMedia`);
  });

  it("an MP4 gets exactly one packet, even when written again", async () => {
    const p = join(dir, "v.mp4");
    await writeFile(p, tinyMp4());
    expect(await writeXmp(p, digitalSourceTypeForTier("B"))).toEqual({ method: "native", format: "mp4" });
    expect((await readFile(p)).toString("latin1")).toContain(`Iptc4xmpExt:DigitalSourceType="${digitalSourceTypeForTier("B")}"`);
    await writeXmp(p, digitalSourceTypeForTier("B"));
    expect((await readFile(p)).toString("latin1").match(/DigitalSourceType=/g)).toHaveLength(1);
  });

  it("a JPEG gets the packet and stays a JPEG", async () => {
    const p = join(dir, "s.jpg");
    await writeFile(p, tinyJpeg());
    expect(await writeXmp(p, digitalSourceTypeForTier("A"))).toEqual({ method: "native", format: "jpeg" });
    const out = await readFile(p);
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect(out.toString("latin1")).toContain(`Iptc4xmpExt:DigitalSourceType="${digitalSourceTypeForTier("A")}"`);
  });

  it("only IPTC source-type URIs are written", async () => {
    const p = join(dir, "x.mp4");
    await writeFile(p, tinyMp4());
    await expect(writeXmp(p, "made by a human, promise")).rejects.toThrow(/Not an IPTC digital source type/);
  });
});
