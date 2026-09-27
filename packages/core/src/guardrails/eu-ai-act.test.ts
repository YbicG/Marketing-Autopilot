// §8 "EU AI Act Art. 50": an IPTC digitalSourceType XMP packet in every final file, written as the
// last change to it. Here: the finalize and still paths call renderer.writeXmp for every output with
// the tier's source type (fake renderer, no ffmpeg). The native writer itself is tested on real
// bytes in packages/video/src/guardrails/xmp.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { digitalSourceType } from "../video/provenance.ts";
import { executeRenderStill } from "../video/stills.ts";
import { seedVideoWorld } from "../video/testing.ts";
import { finalizeAndRender, videoHarness } from "./video-harness.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
});
afterAll(() => close());

describe("§8 EU AI Act Art. 50 (XMP digitalSourceType)", () => {
  it("every finished video file (master + 4 platform files, per opening line) gets the tier's source type", async () => {
    const w = await seedVideoWorld(db);
    const h = videoHarness(db, rates, w);
    const renders = await finalizeAndRender(db, h, w);
    expect(renders).toBe(3);

    expect(h.xmp).toHaveLength(renders * 5);
    // TTS voice + generated music make the video tier B (D18).
    expect(new Set(h.xmp.map((x) => x.dst))).toEqual(new Set([digitalSourceType("B")]));
    expect(digitalSourceType("B")).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia");
    // Each render writes 5 distinct files.
    for (let i = 0; i < renders; i++) expect(new Set(h.xmp.slice(i * 5, i * 5 + 5).map((x) => x.path)).size).toBe(5);
    // Per render: any transcode first, then the 5 XMP writes. Nothing edits a file once it's marked.
    const order = h.log.map((x) => (x === "transcode" ? "T" : x === "xmp" ? "X" : "")).join("");
    expect(order).toMatch(/^(T*X{5}){3}$/);
    const vs = await db.select().from(schema.variants).where(eq(schema.variants.contentItemId, w.itemId));
    expect(vs.every((v) => v.provenanceTier === "B")).toBe(true);
  });

  it("every swipe-post JPEG gets the XMP packet right after it's drawn", async () => {
    const w = await seedVideoWorld(db);
    const h = videoHarness(db, rates, w);
    const spec = {
      schemaVersion: 1,
      slides: [
        { template: "hero", headline: "Syllabus to calendar", body: null, assetId: w.shotId },
        { template: "feature", headline: "Drop the PDF", body: "It reads every date.", assetId: null },
        { template: "cta", headline: "Link in bio", body: null, assetId: null },
      ],
      captions: {},
      altText: null,
      claimRefs: [],
    };
    const id = uuidv7();
    await db.insert(schema.variants).values({
      id,
      workspaceId: w.ws,
      contentItemId: w.itemId,
      platform: "instagram",
      body: { schemaVersion: 1, kind: "carousel", format: "carousel", spec, caption: { text: "x", hashtags: [] }, renderedAssetIds: [] },
      contentHash: "h0",
    });
    const r = await executeRenderStill(h.deps, { contentItemId: w.itemId, variantId: id });
    expect(r!.assetIds).toHaveLength(3);
    expect(h.xmp).toHaveLength(3);
    expect(h.xmp.every((x) => x.path.endsWith(".jpg") && x.dst.startsWith("http://cv.iptc.org/newscodes/digitalsourcetype/"))).toBe(true);
    expect(h.log).toEqual(["still", "xmp", "still", "xmp", "still", "xmp"]);
  });

  it("the source type follows the tier", () => {
    const base = "http://cv.iptc.org/newscodes/digitalsourcetype/";
    expect(digitalSourceType("A")).toBe(`${base}composite`);
    expect(digitalSourceType("C")).toBe(`${base}trainedAlgorithmicMedia`);
  });

  it.todo("the worker's real renderer calls @mkt/video writeXmp (apps/worker/src/jobs/render/renderer.ts:64) on real files — server check, needs ffmpeg");
  it.todo("upstream C2PA manifests are kept and re-signed — M8");
  it.todo("synthetic-voice disclosure template in captions — not built yet (no template found in core)");
});
