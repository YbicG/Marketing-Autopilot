import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CampaignPlan, CarouselVariantBody, ItemBrief, TextVariantBody } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { carouselEditorView, postEditorView, saveCarousel, saveTextVariant, syncDraftStates } from "./editor.ts";
import { estimatePackage } from "./estimate.ts";
import { WEB_GENERATORS, checkMonthLeft, estimateKey, latestCampaign, packageOptions } from "./package-options.ts";
import { buildRecipe } from "./recipe.ts";
import { contrastOf, slideChecks, slideColors, slideDensity } from "./slide-checks.ts";

let db: Db;
let close: () => Promise<void>;
let ws: string;
let productId: string;
let campaignId: string;
let shotId: string;

const AT = new Date("2026-10-10T23:30:00Z");

const plan = {
  schemaVersion: 1,
  startDate: "2026-10-01",
  launchDate: "2026-10-14",
  launchDay: 14,
  timezone: "America/New_York",
  days: 30,
  slots: [],
  items: [],
  overflow: [],
  warnings: [],
} as unknown as CampaignPlan;

const brief = (targets: ItemBrief["targets"]): ItemBrief => ({
  schemaVersion: 1,
  lineKey: "text",
  targets,
  slotIds: [],
  angleIdx: 0,
  openingStyle: "question" as ItemBrief["openingStyle"],
  masterIdx: null,
  launch: false,
  written: null,
});

const textBody = (platform: "x" | "threads", text: string): TextVariantBody => ({
  schemaVersion: 1,
  kind: "post",
  variant: { platform, text, parts: [], hashtags: [], linkToken: null, altText: null, firstComment: null, claimRefs: ["C1"] },
});

async function item(kind: "post" | "carousel" | "bio", key: string, targets: ItemBrief["targets"]) {
  const id = uuidv7();
  await db.insert(schema.contentItems).values({ id, workspaceId: ws, campaignId, deliverableKey: key, kind, status: "ready", day: 10, brief: brief(targets) as unknown as Record<string, unknown> });
  return id;
}

async function variant(contentItemId: string, platform: string, body: object, postState: (typeof schema.POST_STATES)[number] | null = "pending_approval") {
  const id = uuidv7();
  await db.insert(schema.variants).values({ id, workspaceId: ws, contentItemId, platform, body: body as Record<string, unknown>, contentHash: "h0" });
  let postId: string | null = null;
  if (postState) {
    postId = uuidv7();
    await db.insert(schema.posts).values({ id: postId, workspaceId: ws, productId, variantId: id, platform, scheduledAt: AT, state: postState, idempotencyKey: `pst_${postId}_g1` });
  }
  return { id, postId };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ws = uuidv7();
  productId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t", timezone: "America/New_York" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", kind: "web_b2c" });
  const dnaId = uuidv7();
  await db.insert(schema.productDnaVersions).values({ id: dnaId, workspaceId: ws, productId, version: 1, status: "confirmed", dna: {}, fields: {}, sourceMap: {} });
  await db.insert(schema.claims).values([
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C1", kind: "feature", text: "Turns a syllabus into events in about 15 seconds", sourceRefs: ["S1"], publicOk: true },
  ]);
  const strategyId = uuidv7();
  await db.insert(schema.strategies).values({ id: strategyId, workspaceId: ws, productId, dnaVersionId: dnaId, output: {}, launchDate: "2026-10-14" });
  const bundleId = uuidv7();
  await db.insert(schema.campaignBundles).values({ id: bundleId, workspaceId: ws, productId, strategyId, dnaVersionId: dnaId, version: 1, text: "bundle", claimRefs: ["C1"] });
  campaignId = uuidv7();
  await db.insert(schema.campaigns).values({
    id: campaignId,
    workspaceId: ws,
    productId,
    strategyId,
    bundleId,
    tier: "standard",
    startDate: "2026-10-01",
    launchDate: "2026-10-14",
    platforms: ["x", "threads", "instagram", "tiktok"],
    plan: plan as unknown as Record<string, unknown>,
  });
  shotId = uuidv7();
  await db.insert(schema.assets).values({
    id: shotId,
    workspaceId: ws,
    productId,
    kind: "screenshot",
    origin: "captured",
    mime: "image/png",
    sha256: "abc",
    storageKey: "k",
    labels: { caption: "Upload screen", usefulForMarketing: true, hasPersonalData: false },
  });
});
afterAll(async () => {
  await close();
});

describe("post editor", () => {
  it("shows each platform variant with its limit, checks and claim chips", async () => {
    const id = await item("post", "post:text-01", [
      { platform: "x", format: "text" },
      { platform: "threads", format: "text" },
    ]);
    await variant(id, "x", textBody("x", "Drop your syllabus, get your semester. {{link:landing}}"));
    await variant(id, "threads", textBody("threads", "Five syllabi, one calendar, fifteen seconds."));
    const view = await postEditorView(db, ws, id);
    expect(view?.variants.map((v) => [v.platform, v.limit])).toEqual([
      ["x", 280],
      ["threads", 500],
    ]);
    expect(view?.claims).toEqual([{ ref: "C1", text: "Turns a syllabus into events in about 15 seconds", publicOk: true, status: "sourced" }]);
    expect(await postEditorView(db, uuidv7(), id)).toBeNull();
  });

  it("a too-long save blocks, moves the item to Needs you and the post to draft; fixing it undoes both", async () => {
    const id = await item("post", "post:text-02", [{ platform: "x", format: "text" }]);
    const v = await variant(id, "x", textBody("x", "Short and sweet."));
    const long = await saveTextVariant(db, ws, v.id, { text: "a ".repeat(200) });
    expect(long.ok && long.changed).toBe(true);
    expect(long.ok && long.issues.some((i) => i.code === "too_long" && i.severity === "block")).toBe(true);
    await syncDraftStates(db, ws, v.id);
    const [p1] = await db.select().from(schema.posts).where(eq(schema.posts.id, v.postId!));
    const [i1] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, id));
    expect(p1?.state).toBe("draft");
    expect(i1?.status).toBe("needs_you");

    const fixed = await saveTextVariant(db, ws, v.id, { text: "Your whole semester, in your calendar, before class starts." });
    expect(fixed.ok && fixed.issues.filter((i) => i.severity === "block")).toEqual([]);
    await syncDraftStates(db, ws, v.id);
    const [p2] = await db.select().from(schema.posts).where(eq(schema.posts.id, v.postId!));
    const [i2] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, id));
    expect(p2?.state).toBe("pending_approval");
    expect(i2?.status).toBe("ready");
  });

  it("strips raw links and blocks a near-duplicate on X within 14 days", async () => {
    const a = await item("post", "post:text-03", [{ platform: "x", format: "text" }]);
    await variant(a, "x", textBody("x", "Hell week is coming and your calendar has no idea it exists yet"));
    const b = await item("post", "post:text-04", [{ platform: "x", format: "text" }]);
    const v = await variant(b, "x", textBody("x", "Something else entirely."));
    const r = await saveTextVariant(db, ws, v.id, { text: "Hell week is coming and your calendar has no idea it exists yet! https://example.com" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["raw_link_removed", "too_similar"]));
    expect(r.issues.find((i) => i.code === "too_similar")?.severity).toBe("block");
    const [row] = await db.select().from(schema.variants).where(eq(schema.variants.id, v.id));
    expect((row?.body as unknown as TextVariantBody).variant.text).not.toContain("example.com");
  });

  it("refuses edits once a post is publishing or published, and in another workspace", async () => {
    const id = await item("post", "post:text-05", [{ platform: "threads", format: "text" }]);
    const v = await variant(id, "threads", textBody("threads", "Already out there."), "published");
    const r = await saveTextVariant(db, ws, v.id, { text: "Changed" });
    expect(r).toEqual({ ok: false, status: 409, message: "This one is already posted." });
    expect((await saveTextVariant(db, uuidv7(), v.id, { text: "x" })).ok).toBe(false);
  });

  it("checks bios against the platform's bio limit", async () => {
    const id = await item("bio", "bio:bio-01", [{ platform: "tiktok", format: "text" }]);
    const v = await variant(id, "tiktok", { schemaVersion: 1, kind: "bio", text: "Syllabus to calendar." }, null);
    const r = await saveTextVariant(db, ws, v.id, { text: "x".repeat(81) });
    expect(r.ok && r.issues[0]?.message).toContain("80");
    const view = await postEditorView(db, ws, id);
    expect(view?.variants[0]?.limit).toBe(80);
  });
});

describe("swipe post editor", () => {
  const slides = [
    { template: "hero" as const, headline: "Syllabus week, done", body: null, assetId: null },
    { template: "feature" as const, headline: "Drop the PDF", body: "Every date lands in your calendar.", assetId: null },
    { template: "cta" as const, headline: "Try it before class", body: null, assetId: null },
  ];
  const carousel = (platform: "instagram" | "tiktok", format: "carousel" | "photo"): CarouselVariantBody => ({
    schemaVersion: 1,
    kind: "carousel",
    format,
    spec: { schemaVersion: 1, slides, captions: { instagram: { text: "Semester sorted.", hashtags: ["college"] }, tiktok: { text: "Semester sorted.", hashtags: [] } }, altText: null, claimRefs: [] },
    caption: { text: "Semester sorted.", hashtags: [] },
    renderedAssetIds: [],
  });

  it("loads slides, outputs and checks; saves slides for every platform and asks for renders", async () => {
    const id = await item("carousel", "carousel:swipe-01", [
      { platform: "instagram", format: "carousel" },
      { platform: "tiktok", format: "photo" },
    ]);
    const ig = await variant(id, "instagram", carousel("instagram", "carousel"));
    await variant(id, "tiktok", carousel("tiktok", "photo"));
    const view = await carouselEditorView(db, ws, id);
    expect(view?.slides).toHaveLength(3);
    expect(view?.variants.map((v) => v.output.description)).toEqual(["JPEG 1080×1350, up to 10 slides", "Photo post 1080×1920, with music added by TikTok"]);
    expect(view?.screenshots.map((s) => s.id)).toEqual([shotId]);

    const next = [...slides, { template: "proof" as const, headline: "Works with any syllabus", body: null, assetId: shotId }];
    const r = await saveCarousel(db, ws, id, { slides: next, captions: { instagram: { text: "New caption", hashtags: ["#study"] } } });
    expect(r.ok && r.renderVariantIds).toHaveLength(2);
    const [row] = await db.select().from(schema.variants).where(eq(schema.variants.id, ig.id));
    const body = row?.body as unknown as CarouselVariantBody;
    expect(body.spec.slides).toHaveLength(4);
    expect(body.caption).toEqual({ text: "New caption", hashtags: ["study"] });
    expect((await carouselEditorView(db, ws, id))?.variants[0]?.rendering).toBe(true);
  });

  it("rejects links in slides, too few slides and foreign screenshots in plain words", async () => {
    const id = await item("carousel", "carousel:swipe-02", [{ platform: "instagram", format: "carousel" }]);
    await variant(id, "instagram", carousel("instagram", "carousel"));
    const link = await saveCarousel(db, ws, id, { slides: [...slides.slice(0, 2), { ...slides[2]!, body: "go to https://x.com" }] });
    expect(link).toMatchObject({ ok: false, status: 400, message: expect.stringContaining("web addresses") });
    const few = await saveCarousel(db, ws, id, { slides: slides.slice(0, 2) });
    expect(few).toMatchObject({ ok: false, message: expect.stringContaining("3 to 10") });
    const foreign = await saveCarousel(db, ws, id, { slides: [{ ...slides[0]!, assetId: uuidv7() }, ...slides.slice(1)] });
    expect(foreign).toMatchObject({ ok: false, message: "Pick a screenshot from this product." });
  });
});

describe("package options", () => {
  it("prices every tier × platform subset like estimatePackage", () => {
    const o = packageOptions("web_b2c");
    expect(o.platforms).toEqual(["tiktok", "instagram", "youtube", "threads", "x"]);
    expect(Object.keys(o.estimates)).toHaveLength(31 * 3);
    const full = estimatePackage(buildRecipe("web_b2c", "standard", { generators: WEB_GENERATORS, platforms: o.platforms }));
    expect(o.estimates[estimateKey("standard", o.platforms)]?.expected).toBe(full.expected);
    expect(o.estimates[estimateKey("quick", ["x"])]!.expected).toBeLessThan(o.estimates[estimateKey("premium", ["x"])]!.expected);
  });

  it("checks what's left of the month and finds the latest campaign", async () => {
    expect(await checkMonthLeft(db, ws, 60_000_000, 9_000_000)).toEqual({ ok: true, leftMicros: 60_000_000 });
    expect((await checkMonthLeft(db, ws, 5_000_000, 9_000_000)).ok).toBe(false);
    expect((await latestCampaign(db, ws, productId))?.campaign.id).toBe(campaignId);
    expect(await latestCampaign(db, uuidv7(), productId)).toBeNull();
  });
});

describe("slide checks", () => {
  it("flags dense slides and missing headlines", () => {
    expect(slideDensity({ headline: "Short", body: null })).toEqual([]);
    expect(slideDensity({ headline: "", body: null })[0]?.level).toBe("block");
    expect(slideDensity({ headline: "word ".repeat(14), body: "word ".repeat(45) }).length).toBeGreaterThanOrEqual(3);
  });

  it("derives template colours and warns on low contrast", () => {
    expect(contrastOf("#ffffff", "#000000")).toBeCloseTo(21, 0);
    const c = slideColors(["#6366f1"]);
    expect(c.bg).toBe("#0b0b0f");
    expect(slideChecks({ template: "hero", headline: "Fine", body: "Fine too" }, c)).toEqual([]);
    const bad = { ...c, muted: "#222222" };
    expect(slideChecks({ template: "feature", headline: "Hi", body: "Hard to read" }, bad)[0]?.message).toContain("body");
  });
});
