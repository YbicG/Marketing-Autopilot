// §8 "Ad spend": the app spends $0 on ads. It exports files for the person to upload by hand, every
// campaign row says PAUSED and 18+, and the README asks for a daily limit and an end date on the
// platform. The spend governor, typed activation and conversion API arrive in M6.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ADS_SPEND_STATEMENT, AdsExportBody } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { adsExportFiles } from "../ads/export.ts";
import { executeAdsKit } from "../ads/generate.ts";
import { fakeClient, jsonReply } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import type { Storage } from "../media/storage.ts";
import { MEDIA, seedWorkspace, type Seeded } from "../publishing/test-fixtures.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
});
afterAll(() => close());

// Same seed and model replies as ads/ads.test.ts.
async function seedKit(): Promise<{ s: Seeded; kitId: string; runId: string }> {
  const s = await seedWorkspace(db);
  await db
    .update(schema.productDnaVersions)
    .set({ dna: { identity: { name: "SyllaCal", platforms: ["web"] }, market: { pains: [], competitors: [] } } })
    .where(eq(schema.productDnaVersions.id, s.dnaVersionId));
  await db.update(schema.assets).set({ width: 1080, height: 1920 }).where(eq(schema.assets.id, s.assetId));
  const planId = uuidv7();
  await db.insert(schema.launchPlans).values({ id: planId, workspaceId: s.workspaceId, productId: s.productId, campaignId: s.campaignId, startDate: "2026-10-19", launchDate: "2026-11-03", status: "active", templateVersion: "test" });
  const runId = uuidv7();
  await db.insert(schema.generationRuns).values({ id: runId, workspaceId: s.workspaceId, productId: s.productId, kind: "ads_kit", status: "queued", input: {}, capMicros: 2_000_000 });
  const kitId = uuidv7();
  await db.insert(schema.launchKits).values({ id: kitId, workspaceId: s.workspaceId, productId: s.productId, launchPlanId: planId, kind: "ads_export", runId });
  return { s, kitId, runId };
}

function replies(s: Seeded) {
  const reply = (params: Record<string, unknown>) => {
    if (JSON.stringify(params.messages).includes("Plan exactly 3 ad ideas")) {
      return jsonReply({
        concepts: [0, 1, 2].map((i) => ({
          angle: ["Syllabus week, done", "See crunch weeks early", "One price, no subscription"][i],
          openingLine: ["Five syllabi, one tap", "Your hell week, spotted early", "Pay once, plan every term"][i],
          assetIds: [s.assetId],
          renderIds: [],
          visualDescription: "The upload screen turning a PDF into calendar events",
          why: "It's the first chore of every term",
          claimRefs: ["C1"],
        })),
      });
    }
    return jsonReply({
      variants: [0, 1, 2].flatMap((c) =>
        [0, 1].map((n) => ({
          conceptIdx: c,
          primaryText: n ? "Every deadline from every class, in your calendar." : "Drop your syllabus in, get your semester back.",
          headline: "Your semester, sorted",
          description: null,
          callToAction: "Sign up",
          claimRefs: ["C1"],
        })),
      ),
      audience: "College students 18 to 24 in the US who use Google Calendar or Apple Calendar.",
      keywords: [],
    });
  };
  return Array.from({ length: 8 }, () => reply);
}

describe("§8 Ad spend", () => {
  it("the kit's spend line can only be the $0 statement", () => {
    expect(ADS_SPEND_STATEMENT).toMatch(/^\$0 spent by the app/);
    const shape = AdsExportBody.shape.spendStatement;
    expect(shape.safeParse(ADS_SPEND_STATEMENT).success).toBe(true);
    expect(shape.safeParse("We'll spend $50 a day for you").success).toBe(false);
  });

  it("every exported campaign row is PAUSED and 18+, and the README asks for a daily limit and end date", async () => {
    const { s, kitId, runId } = await seedKit();
    const { client } = fakeClient(replies(s));
    expect(await executeAdsKit({ ai: { db, rates, client } }, { runId, workspaceId: s.workspaceId, kitId })).toBe("ready");
    const storage: Storage = { put: async () => {}, delete: async () => {}, get: async (key) => Buffer.from(MEDIA.get(key) ?? new Uint8Array()) };
    const files = await adsExportFiles(db, storage, s.workspaceId, kitId);
    const text = new Map(files.map((f) => [f.path, new TextDecoder().decode(f.bytes)]));

    const readme = text.get("README.md")!;
    expect(readme).toContain(ADS_SPEND_STATEMENT);
    expect(readme).toMatch(/never turns an ad on/);
    expect(readme).toMatch(/\*\*paused\*\*/);
    expect(readme).toMatch(/\*\*18 and over\*\*/);
    expect(readme).toMatch(/\*\*daily limit\*\*/);
    expect(readme).toMatch(/\*\*end date\*\*/);

    const sheets = [...text.keys()].filter((p) => p.endsWith(".csv"));
    expect(sheets.length).toBeGreaterThan(0);
    for (const p of sheets) {
      const [head, ...rows] = text.get(p)!.split(/\r?\n/).filter(Boolean);
      // The campaign-level columns (status, budget, end date, age) come before any free text, so
      // splitting the start of a row on commas is safe.
      const cols = head!.split(",").slice(0, 6);
      const at = (re: RegExp) => cols.findIndex((c) => re.test(c));
      const [status, budget, end, age] = [at(/Status/), at(/[Bb]udget/), at(/End|Stop|end/), at(/^Age/)];
      expect([status, budget, end, age].every((i) => i >= 0)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        const cells = r.split(",");
        expect(cells[status]).toBe("PAUSED");
        expect(["18", "18+"]).toContain(cells[age]);
        // Budget and end date are left for the person to set on the platform.
        expect([cells[budget], cells[end]]).toEqual(["", ""]);
      }
    }
  });

  it.todo("spend governor: daily and total caps the app enforces on live ads — M6 (ads activation not built)");
  it.todo("typed activation: turning an ad on needs the person to type the amount — M6");
  it.todo("conversion API events only after consent — M6 (CAPI not built)");
});
