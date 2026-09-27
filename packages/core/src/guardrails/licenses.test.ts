// §8 "Licenses": every music track, sound effect, device frame and font has a license on file.
// Generated music stores the provider's receipt on the asset; drafts and the no-key cut use the
// bundled licensed track. Fonts are checked in packages/video/src/guardrails/licenses.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { VideoSpec } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { budgetScopesForRun } from "../runs/summary.ts";
import { prepareAudio } from "../video/audio.ts";
import { latestSpec } from "../video/spec.ts";
import { storeAsset } from "../video/store.ts";
import { seedVideoWorld } from "../video/testing.ts";
import { runVideoItem } from "../video/video-item.ts";
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

describe("§8 Licenses", () => {
  it("generated music keeps the provider's license receipt on the asset", async () => {
    const w = await seedVideoWorld(db);
    const h = videoHarness(db, rates, w);
    await finalizeAndRender(db, h, w);
    const music = await db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.workspaceId, w.ws), eq(schema.assets.kind, "audio"), eq(schema.assets.origin, "generated")));
    const tracks = music.filter((a) => (a.origination as { purpose?: string }).purpose === "music");
    expect(tracks.length).toBeGreaterThan(0);
    for (const t of tracks) expect(JSON.parse(t.licenseRef!)).toMatchObject({ kind: "music", ref: expect.any(String), terms: expect.any(String) });
  });

  it("without a key, the cut uses the bundled licensed track, not generated music", async () => {
    const w = await seedVideoWorld(db);
    const h = videoHarness(db, rates, w);
    await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
    const spec = (await latestSpec(db, w.ws, w.itemId))!.spec as unknown as VideoSpec;
    const plan = await prepareAudio({ ...h.deps, audio: null, bundledTrackAssetId: "bundled-1" }, { workspaceId: w.ws, runId: w.runId, budgetPeriodIds: [] }, {
      productId: w.productId,
      spec,
      quality: "final",
      withMusic: true,
    });
    expect(plan).toMatchObject({ musicAssetId: "bundled-1", musicFallback: true });
  });

  // GAP: a spec's music.trackAssetId is used as-is (core/src/video/audio.ts:262, prepareAudio);
  // nothing checks the asset has a licenseRef. Fix there (or in lintSpec's LintAsset,
  // packages/video/src/spec/lint.ts:7) by refusing a music track with no license on file.
  it.fails("GAP: an uploaded track with no license on file is refused as the video's music", async () => {
    const w = await seedVideoWorld(db);
    const h = videoHarness(db, rates, w);
    await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
    const spec = (await latestSpec(db, w.ws, w.itemId))!.spec as unknown as VideoSpec;
    const song = await storeAsset(db, h.deps.storage, {
      workspaceId: w.ws,
      productId: w.productId,
      kind: "audio",
      origin: "uploaded",
      tier: "A",
      mime: "audio/mpeg",
      ext: "mp3",
      bytes: new TextEncoder().encode("SOMEONE ELSE'S SONG"),
      licenseRef: null,
    });
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, w.runId));
    const scope = { workspaceId: w.ws, runId: w.runId, budgetPeriodIds: await budgetScopesForRun(db, w.ws, w.runId, run!.capMicros) };
    const withSong = { ...spec, music: { ...spec.music, trackAssetId: song.id } };
    await expect(prepareAudio(h.deps, scope, { productId: w.productId, spec: withSong, quality: "final", withMusic: true })).rejects.toThrow();
  });

  it.todo("sound effects carry a license receipt — not wired yet (VideoDeps.audio.sfx exists, nothing calls it)");
  it.todo("device frames have a license on file — no device-frame assets are bundled yet");
});
