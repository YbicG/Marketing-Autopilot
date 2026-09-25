import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CampaignPlan, ItemBrief, ProductDna, StrategyOutput } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { fakeClient, jsonReply } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { campaignBoard } from "./board.ts";
import { estimateTokens } from "./bundle.ts";
import { createPackageRun, orchestrate, resumePackageRun, runItem, type EngineDeps } from "./package.ts";
import { createRefillRun, createRewriteRun, rewriteVariant } from "./refill.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
let ws: string;
let productId: string;
let shotId: string;

const dna: ProductDna = {
  identity: {
    name: "SyllaCal",
    oneLiner: "Syllabus to calendar in 15 seconds",
    category: "Student productivity",
    platforms: ["web"],
    whoItsFor: "College students",
    audiences: [{ name: "Students", description: "Undergrads with 5 classes", painPoints: ["Missed deadlines", "Typing dates by hand"] }],
    jobs: ["Get every deadline into my calendar"],
    voice: { tone: "friendly, a bit dry", wordsToUse: ["semester", "deadline"], wordsToAvoid: ["synergy"] },
  },
  offer: {
    features: [{ name: "Upload", description: "PDF in, events out" }, { name: "Hell week view", description: "See crunch weeks early" }],
    pricing: { model: "one_time", summary: "Three one-time plans from $4.99", tiers: [{ name: "Basic", price: "$4.99", period: "one-time", notes: null }] },
    proof: [],
    differentiators: ["One-time price", "Works with any syllabus PDF"],
  },
  market: {
    competitors: [{ name: "Notion templates", url: null, howTheyDiffer: "Manual entry" }],
    pains: [{ text: "Typing deadlines in by hand takes hours", sourceUrl: null }],
    seasonality: { peaks: [{ months: "Aug–Sep, Jan", reason: "Semester start" }], summary: "Back to school" },
    channels: [{ platform: "TikTok", why: "Students" }],
    searchTerms: ["syllabus to calendar"],
  },
};

const strategy: StrategyOutput = {
  angles: [0, 1, 2].map((i) => ({
    title: ["Syllabus week, done in 15 seconds", "See your hell week before it hits", "No subscription, ever"][i]!,
    forWho: "College students",
    insteadOf: "Typing dates into Google Calendar",
    promise: "Every deadline in your calendar in 15 seconds",
    sampleOpeningLine: "POV: you just got 5 syllabi",
    bestOn: ["tiktok"],
    whyWeSuggest: "It's the first thing students do each term",
    claimIds: ["C1"],
    screenshotAssetIds: [],
  })),
  messaging: {
    oneLiners: ["Drop your syllabus, get your semester"],
    elevatorPitch: "SyllaCal reads your syllabus PDF and puts every deadline in your calendar.",
    objections: [{ objection: "Will it get dates wrong?", answer: "You check every event before it's added." }],
    wordsToUse: ["deadline"],
    wordsToAvoid: ["hack"],
  },
  channelPlan: [{ platform: "tiktok", role: "main", cadence: "3/week" }],
  launchWindow: { suggestedDate: null, reason: "none" },
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
  ws = uuidv7();
  productId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t", timezone: "America/New_York" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", kind: "web_b2c" });
  const dnaId = uuidv7();
  await db.insert(schema.productDnaVersions).values({ id: dnaId, workspaceId: ws, productId, version: 1, status: "confirmed", dna: dna as unknown as Record<string, unknown>, fields: {}, sourceMap: {} });
  await db.insert(schema.claims).values([
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C1", kind: "feature", text: "Turns a syllabus into calendar events in about 15 seconds", sourceRefs: ["S1"], publicOk: true },
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C2", kind: "stat", text: "94% first-try accuracy (internal scorecard)", sourceRefs: ["S5"], publicOk: false },
  ]);
  const strategyId = uuidv7();
  await db.insert(schema.strategies).values({ id: strategyId, workspaceId: ws, productId, dnaVersionId: dnaId, output: strategy as unknown as Record<string, unknown>, launchDate: "2026-10-20" });
  await db.insert(schema.angles).values(
    strategy.angles.map((card, idx) => ({ id: uuidv7(), workspaceId: ws, strategyId, idx, card: card as unknown as Record<string, unknown>, sharePct: [60, 20, 20][idx]! })),
  );
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

// ── a fake Claude that answers by system prompt ──

let n = 0;
let poisonNextPost = false;
const userText = (p: Record<string, unknown>) =>
  (p.messages as { content: string | { text?: string }[] }[])
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("\n")))
    .join("\n");
const systemOf = (p: Record<string, unknown>) => String(p.system);

function router(p: Record<string, unknown>) {
  const sys = systemOf(p);
  const msg = userText(p);
  n++;
  if (sys.includes("You plan a 30-day social campaign")) {
    const keys = [...msg.matchAll(/([a-z]+:[a-z0-9-]+) \|/g)].map((m) => m[1]!);
    return jsonReply({
      briefs: keys.map((k) => ({
        deliverableKey: k,
        topic: `Topic for ${k}`,
        openingLine: "POV: syllabus week",
        keyPoints: ["Drop the PDF"],
        claimRefs: ["C1", "C2"],
        screenshotAssetIds: [shotId, "not-a-real-asset"],
        nextStep: "Try it free",
      })),
    });
  }
  if (sys.includes("You write social posts")) {
    const platforms = [...msg.matchAll(/- (tiktok|instagram|youtube|threads|x|linkedin|bluesky) \(/g)].map((m) => m[1]!);
    const bad = poisonNextPost;
    poisonNextPost = false;
    return jsonReply({
      variants: platforms.map((platform) => ({
        platform,
        text: `Post ${n} ${platform}: every one of your ${n * 7} deadlines, zebra ${n} quokka ${platform} ${"abcdefghij".slice(0, (n % 9) + 1)}`,
        parts: msg.includes("thread of 4") ? ["one", "two", "three", "four"] : [],
        hashtags: ["#college"],
        linkToken: null,
        altText: null,
        firstComment: null,
        claimRefs: bad ? ["C2"] : ["C1"],
      })),
    });
  }
  if (sys.includes("You fix social posts")) {
    const platform = /Fix this (\w+) post/.exec(msg)?.[1]?.toLowerCase() === "threads" ? "threads" : "x";
    return jsonReply({ platform, text: `Fixed post ${n}, no private numbers`, parts: [], hashtags: [], linkToken: null, altText: null, firstComment: null, claimRefs: ["C1"] });
  }
  if (sys.includes("You design swipe posts")) {
    const slide = (template: string, i: number) => ({ template, headline: `Slide ${i} of ${n}`, body: i === 1 ? "Drop the PDF https://evil.test" : null, assetId: i === 2 ? shotId : "bogus" });
    return jsonReply({
      slides: ["hero", "problem", "feature", "steps", "cta"].map(slide),
      captions: [
        { platform: "instagram", text: `Swipe to see syllabus week handled ${n}`, hashtags: ["college"] },
        { platform: "tiktok", text: `Syllabus week in 5 slides ${n}`, hashtags: ["studytok"] },
      ],
      altText: "Five slides showing the upload screen",
      claimRefs: ["C1"],
    });
  }
  if (sys.includes("You write social profile bios")) {
    return jsonReply({
      drafts: ["tiktok", "instagram", "youtube", "threads", "x"].map((platform) => ({ platform, bio: `Syllabus to calendar in 15s (${platform})`, pinnedPost: platform === "x" || platform === "threads" ? "Start here {{link:landing}}" : null })),
    });
  }
  if (sys.includes("You adapt social posts")) {
    return jsonReply({ platform: "threads", text: "Rewritten for Threads, friendlier", parts: [], hashtags: [], linkToken: null, altText: null, firstComment: null, claimRefs: ["C1"] });
  }
  throw new Error(`unexpected call: ${sys.slice(0, 60)}`);
}

function makeDeps() {
  const fake = fakeClient(Array.from({ length: 400 }, () => router));
  const enqueued: { runId: string; itemId: string; jobId: string }[] = [];
  const orch: { runId: string; tick: boolean }[] = [];
  const renders: string[] = [];
  // Getters: the describe body runs before beforeAll opens the db.
  const deps: EngineDeps = {
    get db() {
      return db;
    },
    get rates() {
      return rates;
    },
    client: fake.client,
    enqueueItem: async (runId, itemId, jobId) => void enqueued.push({ runId, itemId, jobId }),
    enqueueOrchestrate: async (runId, o) => void orch.push({ runId, tick: !!o?.tick }),
    enqueueRenderStill: async (_item, variantId) => void renders.push(variantId),
    now: () => new Date("2026-10-01T12:00:00Z"),
  };
  return { deps, enqueued, orch, renders, calls: fake.calls };
}

describe("package run", () => {
  let runId: string;
  let campaignId: string;
  const m = makeDeps();

  it("creates the campaign, run and planned items from the plan", async () => {
    const created = await createPackageRun(db, ws, productId, "quick", { now: new Date("2026-10-01T12:00:00Z") });
    expect(created).not.toBeNull();
    ({ runId, campaignId } = created!);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run).toMatchObject({ kind: "package", status: "queued", capMicros: 5_000_000 });
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(campaign).toMatchObject({ launchDate: "2026-10-20", startDate: "2026-10-07", tier: "quick", runId });
    const plan = campaign!.plan as unknown as CampaignPlan;
    const items = await db.select().from(schema.contentItems).where(eq(schema.contentItems.runId, runId));
    expect(items).toHaveLength(plan.items.length);
    expect(items.every((i) => i.status === "planned")).toBe(true);
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(["carousel", "post", "bio", "pinned"]));
    // Warm-up: the unconnected brand accounts get 1 a day in their first week.
    const tiktokWeek1 = plan.slots.filter((s) => s.platform === "tiktok" && s.day <= 7);
    const perDay = new Map<number, number>();
    for (const s of tiktokWeek1) perDay.set(s.day, (perDay.get(s.day) ?? 0) + 1);
    expect([...perDay.values()].every((c) => c <= 1)).toBe(true);
    // The bundle is frozen and long enough to cache.
    const [bundle] = await db.select().from(schema.campaignBundles).where(eq(schema.campaignBundles.id, campaign!.bundleId!));
    expect(bundle!.version).toBe(1);
    expect(bundle!.claimRefs).toEqual(["C1"]);
    expect(bundle!.text).not.toContain("94%");
    expect(estimateTokens(bundle!.text)).toBeGreaterThan(700);
  });

  it("reuses the bundle when nothing changed", async () => {
    const again = await createPackageRun(db, ws, productId, "quick", { now: new Date("2026-10-01T12:00:00Z") });
    const [c1] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    const [c2] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, again!.campaignId));
    expect(c2!.bundleId).toBe(c1!.bundleId);
  });

  it("orchestrate writes briefs once, then enqueues phase 1; running it twice never duplicates children", async () => {
    const r1 = await orchestrate(m.deps, runId);
    expect(r1.action).toBe("enqueued");
    const briefCalls = m.calls.filter((c) => systemOf(c).includes("You plan a 30-day"));
    expect(briefCalls).toHaveLength(1);
    // The bundle is a cached prefix block.
    const content = (briefCalls[0]!.messages as { content: { cache_control?: unknown; text: string }[] }[])[0]!.content;
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(content[0]!.text).toContain("<campaign_bundle>");

    const items = await db.select().from(schema.contentItems).where(eq(schema.contentItems.runId, runId));
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(m.enqueued.length).toBe(r1.enqueued);
    for (const e of m.enqueued) {
      const it = byId.get(e.itemId)!;
      expect(e.jobId).toBe(`${runId}:${it.deliverableKey}`);
      expect(it.status).toBe("generating");
      expect(it.kind === "carousel" || (it.day ?? 99) <= 7).toBe(true);
    }
    expect(m.enqueued.filter((e) => byId.get(e.itemId)!.kind === "carousel")).toHaveLength(1);
    // Briefs landed, filtered to public claims and real screenshots.
    const [runRow] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(runRow!.result).not.toHaveProperty("briefError");
    const brief = items[0]!.brief as unknown as ItemBrief;
    expect(brief.written?.claimRefs).toEqual(["C1"]);
    expect(brief.written?.screenshotAssetIds).toEqual([shotId]);

    const before = m.enqueued.length;
    const r2 = await orchestrate(m.deps, runId);
    expect(r2.enqueued).toBe(0);
    expect(m.enqueued.length).toBe(before);
    expect(m.calls.filter((c) => systemOf(c).includes("You plan a 30-day"))).toHaveLength(1);
    expect(m.orch.some((o) => o.tick)).toBe(true);
  });

  it("runItem writes variants and pending_approval posts, and hands back to orchestrate", async () => {
    const first = [...m.enqueued];
    poisonNextPost = true; // the first post uses the internal scorecard stat → one repair
    for (const e of first) await runItem(m.deps, e.runId, e.itemId);
    const items = await db.select().from(schema.contentItems).where(eq(schema.contentItems.runId, runId));
    const done = items.filter((i) => first.some((e) => e.itemId === i.id));
    expect(done.filter((i) => i.status !== "ready").map((i) => `${i.deliverableKey} ${i.status} ${i.needsYouReason}`)).toEqual([]);
    expect(done.every((i) => i.costMicros > 0)).toBe(true);
    expect(m.calls.some((c) => systemOf(c).includes("You fix social posts"))).toBe(true);

    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    const plan = campaign!.plan as unknown as CampaignPlan;
    for (const item of done) {
      const vs = await db.select().from(schema.variants).where(eq(schema.variants.contentItemId, item.id));
      const brief = item.brief as unknown as ItemBrief;
      expect(vs).toHaveLength(brief.targets.length);
      for (const v of vs) {
        expect(v.contentHash).toMatch(/^[0-9a-f]{64}$/);
        const body = v.body as { variant?: { claimRefs: string[]; text: string }; spec?: { slides: { body: string | null; assetId: string | null }[] } };
        if (body.variant) {
          expect(body.variant.claimRefs).not.toContain("C2");
          expect(body.variant.text).not.toMatch(/https?:/);
        }
        if (body.spec) {
          expect(body.spec.slides.every((s) => !s.body || !s.body.includes("http"))).toBe(true);
          expect(body.spec.slides.filter((s) => s.assetId).map((s) => s.assetId)).toEqual([shotId]);
        }
        const [post] = await db.select().from(schema.posts).where(eq(schema.posts.variantId, v.id));
        const slot = plan.slots.find((s) => brief.slotIds.includes(s.id) && s.platform === v.platform)!;
        expect(post).toMatchObject({ state: "pending_approval", platform: v.platform, connectionId: null, productId, generation: 1 });
        expect(post!.idempotencyKey).toBe(`pst_${post!.id}_g1`);
        expect(post!.scheduledAt.toISOString()).toBe(slot.scheduledAt);
      }
    }
    const carousel = done.find((i) => i.kind === "carousel")!;
    const cvs = await db.select().from(schema.variants).where(eq(schema.variants.contentItemId, carousel.id));
    expect(m.renders.sort()).toEqual(cvs.map((v) => v.id).sort());
    expect(m.orch.filter((o) => !o.tick).length).toBe(first.length);

    // A duplicate delivery does nothing.
    const calls = m.calls.length;
    await runItem(m.deps, first[0]!.runId, first[0]!.itemId);
    expect(m.calls.length).toBe(calls);
  });

  it("runs the rest, then stops at the human checkpoint", async () => {
    const before = m.enqueued.length;
    const r = await orchestrate(m.deps, runId);
    expect(r.enqueued).toBeGreaterThan(0);
    for (const e of m.enqueued.slice(before)) await runItem(m.deps, e.runId, e.itemId);
    const fin = await orchestrate(m.deps, runId);
    expect(fin.action).toBe("needs_review");
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run!.status).toBe("needs_review");
    expect(run!.result).toMatchObject({ failed: 0 });

    const after = m.enqueued.length;
    const again = await orchestrate(m.deps, runId);
    expect(again.action).toBe("stopped");
    expect(m.enqueued.length).toBe(after);

    // Bio drafts are variants without posts.
    const [bio] = await db.select().from(schema.contentItems).where(and(eq(schema.contentItems.runId, runId), eq(schema.contentItems.kind, "bio")));
    expect(bio!.status).toBe("ready");
    const bvs = await db.select().from(schema.variants).where(eq(schema.variants.contentItemId, bio!.id));
    expect(bvs.length).toBeGreaterThan(0);
    for (const v of bvs) expect(await db.select().from(schema.posts).where(eq(schema.posts.variantId, v.id))).toHaveLength(0);
  });

  it("board shows cards, checks and Open slots", async () => {
    const board = await campaignBoard(db, ws, campaignId);
    expect(board).not.toBeNull();
    expect(board!.strip).toHaveLength(30);
    expect(board!.strip[13]!.launch).toBe(true);
    const swipe = board!.groups.find((g) => g.kind === "carousel")!;
    expect(swipe.label).toBe("Swipe posts");
    expect(swipe.cards.every((c) => c.status === "Ready" && c.aiLabel === "A")).toBe(true);
    const video = board!.groups.find((g) => g.kind === "video")!;
    expect(video.cards).toHaveLength(0);
    expect(video.open.every((o) => o.label === "Open · Coming soon" && !o.available)).toBe(true);
    expect(board!.totals.costMicros).toBeGreaterThan(0);
    // Another workspace can't read it.
    expect(await campaignBoard(db, uuidv7(), campaignId)).toBeNull();
  });

  it("Make more fills a freed slot with a refill run", async () => {
    const [post] = await db
      .select()
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.runId, runId), eq(schema.contentItems.kind, "post")))
      .limit(1);
    await db.update(schema.contentItems).set({ status: "skipped" }).where(eq(schema.contentItems.id, post!.id));
    const slotId = (post!.brief as unknown as ItemBrief).slotIds[0]!;
    const board = await campaignBoard(db, ws, campaignId);
    const open = board!.groups.find((g) => g.kind === "post")!.open.find((o) => o.slotId === slotId)!;
    expect(open.label).toMatch(/^Open · Make more ~\$0\.0\d$/);

    const r = await createRefillRun(db, ws, campaignId, [slotId, "nope"], { now: new Date("2026-10-01T12:00:00Z") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slotIds).toEqual([slotId]);
    const refillItems = await db.select().from(schema.contentItems).where(eq(schema.contentItems.runId, r.runId));
    expect(refillItems).toHaveLength(1);
    expect(refillItems[0]).toMatchObject({ slotKind: "refill", status: "planned" });
    expect(refillItems[0]!.deliverableKey).toMatch(/^post:text-r01$/);
    const rr = await orchestrate(m.deps, r.runId);
    expect(rr.enqueued).toBe(1);
    await runItem(m.deps, r.runId, refillItems[0]!.id);
    expect((await orchestrate(m.deps, r.runId)).action).toBe("needs_review");
    // Video slots can't be refilled before M3a.
    const videoSlot = board!.groups.find((g) => g.kind === "video")!.open[0]!.slotId;
    expect((await createRefillRun(db, ws, campaignId, [videoSlot])).ok).toBe(false);
  });

  it("a budget pause stops orchestrate until resumed", async () => {
    const created = await createPackageRun(db, ws, productId, "quick", { now: new Date("2026-10-01T12:00:00Z") });
    const id = created!.runId;
    await db.update(schema.generationRuns).set({ status: "paused_budget" }).where(eq(schema.generationRuns.id, id));
    const before = m.enqueued.length;
    expect(await orchestrate(m.deps, id)).toMatchObject({ action: "stopped", enqueued: 0 });
    expect(m.enqueued.length).toBe(before);
    expect(await resumePackageRun(db, uuidv7(), id)).toBe(false); // other workspace
    expect(await resumePackageRun(db, ws, id)).toBe(true);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, id));
    expect(run!.status).toBe("running");
  });

  it("rewrites a variant for its platform", async () => {
    const [v] = await db.select().from(schema.variants).where(and(eq(schema.variants.workspaceId, ws), eq(schema.variants.platform, "threads"))).limit(1);
    const rid = await createRewriteRun(db, ws, v!.id);
    expect(rid).not.toBeNull();
    const res = await rewriteVariant(m.deps, rid!, v!.id);
    expect(res).toEqual({ ok: true, message: "Rewritten." });
    const [after] = await db.select().from(schema.variants).where(eq(schema.variants.id, v!.id));
    expect((after!.body as { variant: { text: string } }).variant.text).toBe("Rewritten for Threads, friendlier");
    expect(after!.contentHash).not.toBe(v!.contentHash);
    expect((await rewriteVariant(m.deps, rid!, v!.id)).ok).toBe(false); // already handled
  });
});
