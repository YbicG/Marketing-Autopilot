import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ADS_LIMITS, ADS_SPEND_STATEMENT, AdsExportBody, type AdCopy, type RunEvent } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { fakeClient, jsonReply } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import type { Storage } from "../media/storage.ts";
import { MEDIA, seedWorkspace, type Seeded } from "../publishing/test-fixtures.ts";
import { ADS_KIT_CAP_MICROS, estimateAdsKitMicros } from "./estimate.ts";
import { adsExportFiles, AdsExportRefused, csvCell } from "./export.ts";
import { aspectOf, creativesFor, executeAdsKit } from "./generate.ts";
import { checkAdCopy, checkConcept, checkKeywords, type AdClaim, type AdsCheckCtx } from "./validate.ts";

const PAIN = "Typing deadlines in by hand takes hours every single week";
const LAUNCH_END = new Date("2026-11-04T05:00:00Z");

const claim = (ref: string, over: Partial<AdClaim> = {}): [string, AdClaim] => [
  ref,
  { ref, kind: "feature", text: "Turns a syllabus into a calendar", quote: null, publicOk: true, status: "sourced", expiresAt: null, ...over },
];
const ctx: AdsCheckCtx = {
  claims: new Map([
    claim("C1"),
    claim("C2", { kind: "stat", text: "Reads a syllabus in 15 seconds" }),
    claim("C3", { publicOk: false }),
    claim("C4", { expiresAt: new Date("2026-11-03T20:00:00Z") }),
    claim("C5", { kind: "testimonial" }),
    claim("C6", { status: "rejected" }),
  ]),
  validThrough: LAUNCH_END,
  thirdPartyTexts: [PAIN],
};
const copy = (over: Partial<AdCopy> = {}): AdCopy => ({
  conceptIdx: 0,
  primaryText: "Drop your syllabus in and get the whole semester in your calendar.",
  headline: "Your semester, sorted",
  description: null,
  callToAction: "Sign up",
  claimRefs: ["C1"],
  ...over,
});
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe("ads validators (§8)", () => {
  it("clean copy passes", () => {
    const r = checkAdCopy(copy(), "meta", ctx, "Meta ad 1a");
    expect(r.issues.filter((i) => i.severity === "block")).toEqual([]);
    expect(r.copy.callToAction).toBe("Sign up");
  });

  it("blocks quotes and third-party wording (no competitor review quotes, no quoted pains)", () => {
    expect(codes(checkAdCopy(copy({ primaryText: 'One review says "this app changed my whole semester" and we agree.' }), "meta", ctx, "Meta ad"))).toContain("quote_in_ad");
    expect(codes(checkAdCopy(copy({ primaryText: `Sick of it? typing deadlines in by hand takes hours every week.` }), "meta", ctx, "Meta ad"))).toContain("third_party_text");
    // A short quoted phrase is fine.
    expect(codes(checkAdCopy(copy({ primaryText: 'Say "done" to syllabus week.' }), "meta", ctx, "Meta ad"))).not.toContain("quote_in_ad");
  });

  it("blocks numbers without a fact and every bad claim ref", () => {
    expect(codes(checkAdCopy(copy({ primaryText: "Save 10 hours this semester.", claimRefs: [] }), "meta", ctx, "Meta ad"))).toContain("number_without_source");
    expect(codes(checkAdCopy(copy({ primaryText: "The fastest way to plan a semester.", claimRefs: [] }), "meta", ctx, "Meta ad"))).toContain("number_without_source");
    expect(codes(checkAdCopy(copy({ primaryText: "Reads a syllabus in 15 seconds.", claimRefs: ["C2"] }), "meta", ctx, "Meta ad"))).not.toContain("number_without_source");
    expect(codes(checkAdCopy(copy({ claimRefs: ["C9"] }), "meta", ctx, "a"))).toContain("unknown_fact");
    expect(codes(checkAdCopy(copy({ claimRefs: ["C3"] }), "meta", ctx, "a"))).toContain("internal_fact");
    expect(codes(checkAdCopy(copy({ claimRefs: ["C4"] }), "meta", ctx, "a"))).toContain("fact_expires");
    expect(codes(checkAdCopy(copy({ claimRefs: ["C5"] }), "meta", ctx, "a"))).toContain("testimonial_unverified");
    expect(codes(checkAdCopy(copy({ claimRefs: ["C6"] }), "meta", ctx, "a"))).toContain("rejected_fact");
  });

  it("per-platform limits: over the max blocks, over the recommended length warns", () => {
    const long = "Drop your syllabus in and every deadline lands in your calendar, sorted by class. ".repeat(2).trim();
    const tt = checkAdCopy(copy({ primaryText: long }), "tiktok", ctx, "TikTok ad 1a");
    expect(tt.issues.find((i) => i.code === "too_long")).toMatchObject({ severity: "block" });
    expect(tt.issues.find((i) => i.code === "too_long")!.message).toContain(`TikTok allows ${ADS_LIMITS.tiktok.fields.primaryText!.max}`);
    const meta = checkAdCopy(copy({ primaryText: long }), "meta", ctx, "Meta ad 1a");
    expect(meta.issues.find((i) => i.code === "long_for_placement")).toMatchObject({ severity: "warn" });
    expect(codes(checkAdCopy(copy({ headline: "x".repeat(71) }), "x", ctx, "X ad"))).toContain("too_long");
  });

  it("fields the platform lacks are dropped; required ones missing block; buttons and links are fixed", () => {
    const tt = checkAdCopy(copy({ headline: "Not on TikTok" }), "tiktok", ctx, "TikTok ad");
    expect(tt.copy.headline).toBeNull();
    expect(codes(checkAdCopy(copy({ headline: null }), "reddit", ctx, "Reddit ad"))).toContain("missing_field");
    const r = checkAdCopy(copy({ headline: "Sorted {{link:landing}}", callToAction: "Buy now!!" }), "reddit", ctx, "Reddit ad");
    expect(r.copy.headline).toBe("Sorted");
    expect(r.copy.callToAction).toBe("Learn More");
    expect(codes(r)).toEqual(expect.arrayContaining(["raw_link_removed", "button_changed"]));
    expect(checkAdCopy(copy({ callToAction: "sign up" }), "reddit", ctx, "Reddit ad").copy.callToAction).toBe("Sign Up");
    expect(checkAdCopy(copy(), "x", ctx, "X ad").copy.callToAction).toBeNull();
  });

  it("concepts keep only real picture ids; keywords drop competitor names", () => {
    const r = checkConcept(
      { angle: "Syllabus week", openingLine: "Five syllabi, one tap", assetIds: ["a1", "nope"], renderIds: [], visualDescription: "The upload screen", why: "It's the first chore of term", claimRefs: [] },
      0,
      ctx,
      { assetIds: new Set(["a1"]), renderIds: new Set() },
    );
    expect(r.concept.visual.assetIds).toEqual(["a1"]);
    expect(codes(r)).toEqual(["unknown_visual"]);
    const k = checkKeywords(["Syllabus Calendar", "syllabus calendar", "notion templates for school", "x".repeat(90)], ["Notion templates"]);
    expect(k.keywords).toEqual(["syllabus calendar"]);
    expect(codes(k)).toEqual(["competitor_keyword"]);
  });

  it("aspect and creative picking", () => {
    expect(aspectOf(1080, 1920)).toBe("9x16");
    expect(aspectOf(1080, 1350)).toBe("4x5");
    expect(aspectOf(null, 10)).toBeNull();
    const refs = creativesFor(
      "meta",
      [{ idx: 0, angle: "a", openingLine: "b", why: "c", claimRefs: [], visual: { assetIds: ["sq"], renderIds: ["v"], description: "" } }],
      [
        { kind: "render", id: "v", aspect: "9x16", label: "" },
        { kind: "asset", id: "sq", aspect: "1x1", label: "" },
      ],
    );
    expect(refs.map((r) => `${r.placement}:${r.id}`)).toEqual(["Feeds:sq", "Stories and Reels:v"]);
  });

  it("csv cells are quoted and formulas defused", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(null)).toBe("");
  });

  it("estimate: expected under $1, the worst case under the run cap", () => {
    const e = estimateAdsKitMicros();
    expect(e.expected).toBeGreaterThan(0);
    expect(e.expected).toBeLessThan(1_000_000);
    expect(e.expected).toBeLessThan(e.high);
    expect(e.high).toBeLessThan(ADS_KIT_CAP_MICROS);
    expect(estimateAdsKitMicros({ platforms: 1 }).high).toBeLessThan(e.high);
  });
});

// ── generation + export through the DB ──

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
});
afterAll(() => close());

const DNA = {
  identity: { name: "SyllaCal", platforms: ["web"] },
  market: { pains: [{ text: PAIN, sourceUrl: null }], competitors: [{ name: "Notion templates", url: null, howTheyDiffer: "You type every date in yourself by hand" }] },
};

async function seedKit(opts: { withCampaign?: boolean } = {}): Promise<{ s: Seeded; kitId: string; runId: string }> {
  const s = await seedWorkspace(db);
  await db.update(schema.productDnaVersions).set({ dna: DNA }).where(eq(schema.productDnaVersions.id, s.dnaVersionId));
  await db.update(schema.assets).set({ width: 1080, height: 1920 }).where(eq(schema.assets.id, s.assetId));
  if (opts.withCampaign === false) await db.delete(schema.campaigns).where(eq(schema.campaigns.id, s.campaignId));
  const planId = uuidv7();
  await db.insert(schema.launchPlans).values({
    id: planId,
    workspaceId: s.workspaceId,
    productId: s.productId,
    campaignId: opts.withCampaign === false ? null : s.campaignId,
    startDate: "2026-10-19",
    launchDate: "2026-11-03",
    status: "active",
    templateVersion: "test",
  });
  const runId = uuidv7();
  await db.insert(schema.generationRuns).values({ id: runId, workspaceId: s.workspaceId, productId: s.productId, kind: "ads_kit", status: "queued", input: {}, capMicros: 2_000_000 });
  const kitId = uuidv7();
  await db.insert(schema.launchKits).values({ id: kitId, workspaceId: s.workspaceId, productId: s.productId, launchPlanId: planId, kind: "ads_export", runId });
  return { s, kitId, runId };
}

const flat = (params: Record<string, unknown>) => JSON.stringify(params.messages);

function replies(s: Seeded, conceptOver: Record<string, unknown> = {}) {
  const reply = (params: Record<string, unknown>) => {
    const m = flat(params);
    if (m.includes("Plan exactly 3 ad ideas")) {
      return jsonReply({
        concepts: [0, 1, 2].map((i) => ({
          angle: ["Syllabus week, done", "See crunch weeks early", "One price, no subscription"][i],
          openingLine: ["Five syllabi, one tap", "Your hell week, spotted early", "Pay once, plan every term"][i],
          assetIds: i === 0 ? [s.assetId, "not-a-real-id"] : [s.assetId],
          renderIds: [],
          visualDescription: "The upload screen turning a PDF into calendar events",
          why: "It's the first chore of every term",
          claimRefs: ["C1"],
          ...(i === 0 ? conceptOver : {}),
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

describe("executeAdsKit", () => {
  it("writes 3 concepts and per-platform copy with fakeClient; the kit is ready and exports", async () => {
    const { s, kitId, runId } = await seedKit();
    const { client, calls } = fakeClient(replies(s));
    const events: RunEvent[] = [];
    const out = await executeAdsKit({ ai: { db, rates, client }, publish: async (e) => void events.push(e) }, { runId, workspaceId: s.workspaceId, kitId });
    expect(out).toBe("ready");
    // Opus once for the ideas, Sonnet once per platform; Apple Search Ads is skipped for a web product.
    expect(calls.map((c) => c.model)).toEqual(["claude-opus-5", ...Array(5).fill("claude-sonnet-5")]);
    // Every call carries the cached campaign bundle.
    expect(calls.every((c) => flat(c).includes("Campaign bundle v1"))).toBe(true);

    const [kit] = await db.select().from(schema.launchKits).where(eq(schema.launchKits.id, kitId));
    expect(kit).toMatchObject({ status: "ready", disclosuresOk: true, claimIds: ["C1"], needsYouReason: null });
    const body = AdsExportBody.parse(kit!.body);
    expect(body.concepts).toHaveLength(3);
    expect(body.concepts[0]!.visual.assetIds).toEqual([s.assetId]);
    expect(body.spendStatement).toBe(ADS_SPEND_STATEMENT);
    expect(body.platforms.apple_search_ads.skipped).toMatch(/App Store/);
    expect(body.platforms.meta.copy).toHaveLength(6);
    expect(body.platforms.x.copy.every((c) => c.callToAction === null)).toBe(true);
    expect(body.platforms.tiktok.copy.every((c) => c.headline === null)).toBe(true);
    expect(body.platforms.tiktok.creatives[0]).toMatchObject({ kind: "asset", id: s.assetId, aspect: "9x16" });
    expect(kit!.issues.map((i) => i.code)).toContain("unknown_visual");
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run!.status).toBe("completed");
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["stage_started", "artifact_ready", "run_completed"]));

    // A second delivery of the same job does nothing.
    expect(await executeAdsKit({ ai: { db, rates, client } }, { runId, workspaceId: s.workspaceId, kitId })).toBe("skipped");

    const storage: Storage = { put: async () => {}, delete: async () => {}, get: async (key) => Buffer.from(MEDIA.get(key) ?? new Uint8Array()) };
    const files = await adsExportFiles(db, storage, s.workspaceId, kitId);
    const byPath = new Map(files.map((f) => [f.path, new TextDecoder().decode(f.bytes)]));
    expect([...byPath.keys()].sort()).toEqual(
      ["README.md", "ads.json", "linkedin/ads.csv", "meta/ads.csv", "reddit/ads.csv", "tiktok/ads.csv", "x/ads.csv", `creatives/idea-1-${s.assetId.replaceAll("-", "").slice(-8)}.png`].sort(),
    );
    const readme = byPath.get("README.md")!;
    expect(readme).toContain(ADS_SPEND_STATEMENT);
    expect(readme).toMatch(/\*\*paused\*\*/);
    expect(readme).toMatch(/18 and over/);
    expect(readme).toMatch(/\*\*end date\*\*/);
    expect(readme).toMatch(/\*\*daily limit\*\*/);
    expect(readme).toMatch(/approximations/);
    const meta = byPath.get("meta/ads.csv")!.split("\r\n");
    expect(meta[0]).toMatch(/^Campaign Name,Campaign Status,/);
    expect(meta[1]).toContain(",PAUSED,");
    expect(meta[1]).toContain("utm_medium=paid");
    expect(meta[1]).toContain("utm_content=idea-1");
    expect(meta.filter(Boolean)).toHaveLength(1 + 6 * 2); // 6 versions × 2 placements
    const media = files.find((f) => f.path.startsWith("creatives/"))!;
    expect(Buffer.from(media.bytes).equals(Buffer.from(MEDIA.get(`ws/${s.workspaceId}/a/${s.assetId}.png`)!))).toBe(true);
    expect(JSON.parse(byPath.get("ads.json")!).concepts).toHaveLength(3);

    // Workspace-scoped.
    const other = await seedWorkspace(db);
    await expect(adsExportFiles(db, storage, other.workspaceId, kitId)).rejects.toBeInstanceOf(AdsExportRefused);
  });

  it("a quoted competitor review holds the kit (Needs you) and it won't export", async () => {
    const { s, kitId, runId } = await seedKit();
    const { client } = fakeClient(replies(s, { openingLine: 'Reviewers say "you type every date in yourself by hand" with Notion' }));
    expect(await executeAdsKit({ ai: { db, rates, client } }, { runId, workspaceId: s.workspaceId, kitId })).toBe("needs_you");
    const [kit] = await db.select().from(schema.launchKits).where(eq(schema.launchKits.id, kitId));
    expect(kit!.status).toBe("needs_you");
    expect(kit!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["quote_in_ad", "third_party_text"]));
    expect(kit!.needsYouReason).toMatch(/Idea 1 quotes someone/);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run!.status).toBe("needs_review");
    const storage: Storage = { put: async () => {}, delete: async () => {}, get: async () => Buffer.alloc(0) };
    await expect(adsExportFiles(db, storage, s.workspaceId, kitId)).rejects.toThrow(/Fix this first/);
  });

  it("no campaign yet: Needs you, nothing spent", async () => {
    const { s, kitId, runId } = await seedKit({ withCampaign: false });
    const { client, calls } = fakeClient([]);
    expect(await executeAdsKit({ ai: { db, rates, client } }, { runId, workspaceId: s.workspaceId, kitId })).toBe("needs_you");
    expect(calls).toHaveLength(0);
    const [kit] = await db.select().from(schema.launchKits).where(eq(schema.launchKits.id, kitId));
    expect(kit).toMatchObject({ status: "needs_you", needsYouReason: "Make your campaign first: the ads kit is written from it." });
  });
});
