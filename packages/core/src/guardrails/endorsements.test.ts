// §8 "Endorsements" (16 CFR 255): ambassador, creator and referral kits carry disclosure copy and
// TikTok branded-content steps, and the kit won't export without it. The ads kit likewise.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AmbassadorKitBody, SubredditKitBody } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { adsExportFiles, AdsExportRefused } from "../ads/export.ts";
import { disclosuresOk, exportBlocker, validateKitBody, type KitCheckCtx } from "../launch/kit/checks.ts";
import { exportKit } from "../launch/kit/export.ts";
import { AMBASSADOR_CAPTION_PREFIX, AMBASSADOR_DISCLOSURE, TIKTOK_BRANDED_CONTENT_STEPS, creatorDisclosure } from "../launch/kit/links.ts";
import { seedWorkspace, type Seeded } from "../publishing/test-fixtures.ts";
import { memoryStorage } from "../video/testing.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const ctx: KitCheckCtx = {
  claims: new Map(),
  validThrough: new Date("2027-01-19T23:59:59Z"),
  knownPrices: new Set(),
  competitors: [],
  inputs: {},
  assetIds: new Set(),
};

const amb = (over: Partial<AmbassadorKitBody> = {}): AmbassadorKitBody => ({
  schemaVersion: 1,
  kind: "ambassador",
  pitch: "Help classmates stop typing deadlines by hand.",
  perks: ["[What you'll give ambassadors]"],
  templates: [1, 2, 3].map(() => ({ channel: "dm" as const, subject: null, text: "Hey [Name], want to be a SyllaCal ambassador at [Campus]?" })),
  postingGuide: ["Post once a week", "Always disclose"],
  captionExamples: [`${AMBASSADOR_CAPTION_PREFIX} Syllabus week took me 2 minutes.`],
  disclosure: AMBASSADOR_DISCLOSURE,
  brandedContentSteps: [...TIKTOK_BRANDED_CONTENT_STEPS],
  links: [{ name: "Maya", ref: "maya", url: "https://syllacal.com/go/maya" }],
  claimRefs: [],
  ...over,
});

const creator = () => ({
  schemaVersion: 1 as const,
  kind: "creator" as const,
  whatItIs: "It reads a syllabus.",
  whatToShow: ["Dropping a PDF"],
  dos: ["Be honest"],
  donts: ["Promise grades"],
  disclosure: creatorDisclosure("SyllaCal"),
  brandedContentSteps: [...TIKTOK_BRANDED_CONTENT_STEPS],
  dmTemplates: [{ text: "Hi [Creator name]" }],
  claimRefs: [],
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("§8 Endorsements: disclosure checks", () => {
  it("ambassador: disclosure first in every caption, and TikTok's branded-content steps", () => {
    expect(disclosuresOk(validateKitBody(amb(), ctx))).toBe(true);
    const late = validateKitBody(amb({ captionExamples: ["Syllabus week took me 2 minutes #ad"] }), ctx);
    expect(codes(late)).toContain("caption_without_disclosure");
    expect(disclosuresOk(late)).toBe(false);
    expect(disclosuresOk(validateKitBody(amb({ brandedContentSteps: ["Post it"] }), ctx))).toBe(false);
  });

  it("creator: the paid-partnership label and caption prefix are required", () => {
    const body = creator();
    expect(disclosuresOk(validateKitBody(body, ctx))).toBe(true);
    expect(disclosuresOk(validateKitBody({ ...body, disclosure: { ...body.disclosure, rules: ["Be nice"] } }, ctx))).toBe(false);
    expect(disclosuresOk(validateKitBody({ ...body, disclosure: { ...body.disclosure, captionPrefix: "Check this out" } }, ctx))).toBe(false);
  });

  it("subreddit and press: the maker says they made it", () => {
    const sub = (b: string): SubredditKitBody => ({
      schemaVersion: 1,
      kind: "subreddit",
      drafts: [{ subreddit: "college", title: "I made a thing", body: b, whyThisFits: "Students", bestTime: "Tue 10am", rulesUrl: "https://www.reddit.com/r/college/about/rules", claimRefs: [], likelyNotAllowed: false, proposed: false, checkNote: null, assistedTaskId: null }],
      assistedTaskIds: [],
    });
    const subCtx = { ...ctx, inputs: { subreddit: { communities: ["college"], dueDate: null } } };
    expect(disclosuresOk(validateKitBody(sub("Here's an app."), subCtx))).toBe(false);
    expect(disclosuresOk(validateKitBody(sub("I made this for my own classes."), subCtx))).toBe(true);
  });

  it("the export blocker names the missing disclosure", () => {
    const msg = exportBlocker("ambassador", "needs_you", [{ code: "caption_without_disclosure", severity: "block", message: "Caption 1 doesn't start with the disclosure." }], false);
    expect(msg).toBe("This kit can't be downloaded until every disclosure is in place: Caption 1 doesn't start with the disclosure.");
    // Even a kit marked ready can't be downloaded without its disclosures.
    expect(exportBlocker("ambassador", "ready", [], false)).toMatch(/every disclosure is in place/);
    expect(exportBlocker("ambassador", "ready", [], true)).toBeNull();
  });
});

async function kitWorld() {
  const s = await seedWorkspace(db);
  await db
    .update(schema.productDnaVersions)
    .set({ dna: { identity: { name: "SyllaCal" }, offer: { pricing: { tiers: [], summary: "" } }, market: { competitors: [] } } })
    .where(eq(schema.productDnaVersions.id, s.dnaVersionId));
  const planId = uuidv7();
  await db.insert(schema.launchPlans).values({
    id: planId,
    workspaceId: s.workspaceId,
    productId: s.productId,
    campaignId: s.campaignId,
    startDate: "2027-01-06",
    launchDate: "2027-01-19",
    status: "active",
    templateVersion: "test",
  });
  return { s, planId };
}

async function insertKit(s: Seeded, planId: string | null, kind: "ambassador" | "ads_export", body: Record<string, unknown>, status: "ready" | "needs_you", disclosuresOkFlag: boolean) {
  const id = uuidv7();
  await db.insert(schema.launchKits).values({ id, workspaceId: s.workspaceId, productId: s.productId, launchPlanId: planId, kind, status, body, disclosuresOk: disclosuresOkFlag });
  return id;
}

describe("§8 Endorsements: the kit won't export without disclosures", () => {
  it("a kit stored without its disclosures is refused", async () => {
    const { s, planId } = await kitWorld();
    const id = await insertKit(s, planId, "ambassador", amb({ captionExamples: ["Loving it #ad"] }) as unknown as Record<string, unknown>, "needs_you", false);
    await expect(exportKit({ db, storage: memoryStorage() }, s.workspaceId, id)).rejects.toThrow(/every disclosure is in place/);
  });

  it("the body is checked again at export: a row that claims disclosures are fine but lacks them is refused", async () => {
    const { s, planId } = await kitWorld();
    const bad = amb({ brandedContentSteps: ["Post it"] });
    const id = await insertKit(s, planId, "ambassador", bad as unknown as Record<string, unknown>, "ready", true);
    await expect(exportKit({ db, storage: memoryStorage() }, s.workspaceId, id)).rejects.toThrow(/every disclosure is in place/);
    const [row] = await db.select().from(schema.launchKits).where(eq(schema.launchKits.id, id));
    expect(row!.disclosuresOk).toBe(false);
  });

  it("a fully disclosed kit exports", async () => {
    const { s, planId } = await kitWorld();
    const id = await insertKit(s, planId, "ambassador", amb() as unknown as Record<string, unknown>, "ready", true);
    const out = await exportKit({ db, storage: memoryStorage() }, s.workspaceId, id);
    expect(out.files.length).toBeGreaterThan(0);
  });

  it("the ads kit won't export unless it's ready with disclosures", async () => {
    const { s, planId } = await kitWorld();
    const storage = memoryStorage();
    const notOk = await insertKit(s, planId, "ads_export", {}, "ready", false);
    await expect(adsExportFiles(db, storage, s.workspaceId, notOk)).rejects.toBeInstanceOf(AdsExportRefused);
    const held = await insertKit(s, null, "ads_export", {}, "needs_you", true);
    await expect(adsExportFiles(db, storage, s.workspaceId, held)).rejects.toThrow(/isn't ready/);
  });

  it.todo("the app never sends DMs: kit templates are text to copy (structural; no DM-sending provider exists in packages/providers)");
});
