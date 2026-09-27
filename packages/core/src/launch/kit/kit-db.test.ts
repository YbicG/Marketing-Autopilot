import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AmbassadorKitBody, KitInputs, ProductDna, ReplyBankBody, RunEvent, StrategyOutput, SubredditKitBody } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { fakeClient, jsonReply } from "../../ai/testing.ts";
import type { RateLookup } from "../../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../../cost/rates.ts";
import { fsStorage, type Storage } from "../../media/storage.ts";
import { ADS_KIT_CAP_MICROS } from "../../ads/index.ts";
import { estimateKitRun } from "./estimate.ts";
import { exportKit } from "./export.ts";
import { AMBASSADOR_CAPTION_PREFIX } from "./links.ts";
import { KIT_SYSTEM } from "./prompts.ts";
import { createKitRun, executeLaunchKit, planKitRun, type AdsKitCtx, type KitDeps } from "./run.ts";
import { kitView, saveKitBody } from "./view.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
let storage: Storage;
let dir: string;
let ws: string;
let productId: string;
let planId: string;
let shotId: string;

const dna: ProductDna = {
  identity: {
    name: "SyllaCal",
    oneLiner: "Syllabus to calendar in 15 seconds",
    category: "Student productivity",
    platforms: ["web"],
    whoItsFor: "College students",
    audiences: [{ name: "Students", description: "Undergrads", painPoints: ["Missed deadlines"] }],
    jobs: ["Get every deadline into my calendar"],
    voice: { tone: "friendly", wordsToUse: ["semester"], wordsToAvoid: ["synergy"] },
  },
  offer: {
    features: [{ name: "Upload", description: "PDF in, events out" }],
    pricing: { model: "one_time", summary: "One-time plans from $4.99", tiers: [{ name: "Basic", price: "$4.99", period: "one-time", notes: null }] },
    proof: [],
    differentiators: ["One-time price"],
  },
  market: {
    competitors: [{ name: "Notion templates", url: null, howTheyDiffer: "Manual entry" }],
    pains: [{ text: "Typing deadlines by hand", sourceUrl: null }],
    seasonality: { peaks: [], summary: "Back to school" },
    channels: [],
    searchTerms: [],
  },
};

const strategy: StrategyOutput = {
  angles: [
    {
      title: "Syllabus week, done",
      forWho: "College students",
      insteadOf: "Typing dates",
      promise: "Every deadline in your calendar",
      sampleOpeningLine: "POV: 5 syllabi",
      bestOn: ["tiktok"],
      whyWeSuggest: "First thing students do",
      claimIds: ["C1"],
      screenshotAssetIds: [],
    },
  ],
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
  dir = await mkdtemp(join(tmpdir(), "mkt-kit-"));
  storage = fsStorage(dir);
  ws = uuidv7();
  productId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t", timezone: "America/New_York" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", kind: "web_b2c", urls: { website: "https://syllacal.com" } });
  const dnaId = uuidv7();
  await db.insert(schema.productDnaVersions).values({ id: dnaId, workspaceId: ws, productId, version: 1, status: "confirmed", dna: dna as unknown as Record<string, unknown>, fields: {}, sourceMap: {} });
  await db.update(schema.products).set({ currentDnaVersionId: dnaId }).where(eq(schema.products.id, productId));
  await db.insert(schema.claims).values([
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C1", kind: "feature", text: "Turns a syllabus into calendar events in about 15 seconds", sourceRefs: ["S1"], publicOk: true },
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C2", kind: "stat", text: "94% first-try accuracy (internal)", sourceRefs: ["S5"], publicOk: false },
  ]);
  const strategyId = uuidv7();
  await db.insert(schema.strategies).values({ id: strategyId, workspaceId: ws, productId, dnaVersionId: dnaId, output: strategy as unknown as Record<string, unknown>, launchDate: "2027-01-19" });
  await db.insert(schema.angles).values({ id: uuidv7(), workspaceId: ws, strategyId, idx: 0, card: strategy.angles[0] as unknown as Record<string, unknown>, sharePct: 100 });
  planId = uuidv7();
  await db.insert(schema.launchPlans).values({ id: planId, workspaceId: ws, productId, startDate: "2026-12-20", launchDate: "2027-01-19", templateVersion: "v1" });
  shotId = uuidv7();
  const key = `ws/${ws}/assets/shot.png`;
  await storage.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await db.insert(schema.assets).values({ id: shotId, workspaceId: ws, productId, kind: "screenshot", origin: "captured", mime: "image/png", sha256: "shot", storageKey: key, labels: { caption: "Upload screen", usefulForMarketing: true, hasPersonalData: false } });
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

// ── fake Claude: a queue of answers per kit kind, picked by system prompt ──

type Answer = unknown | { refuse: true };
const answers: Record<string, Answer[]> = { subreddit: [], ambassador: [], press: [], creator: [], reply_bank: [] };
const kindOf = (p: Record<string, unknown>) => Object.entries(KIT_SYSTEM).find(([, s]) => s === p.system)?.[0];
function router(p: Record<string, unknown>) {
  const kind = kindOf(p);
  const next = kind ? answers[kind]!.shift() : undefined;
  if (next === undefined) throw new Error(`no fake answer for ${kind ?? String(p.system).slice(0, 40)}`);
  if (next && typeof next === "object" && "refuse" in next) return { stop_reason: "refusal", stop_details: { category: "test" }, content: [] } as never;
  return jsonReply(next);
}

const events: RunEvent[] = [];
const rulesFetched: string[] = [];
let adsCalls: AdsKitCtx[] = [];
function deps(nCalls: number): KitDeps {
  const { client } = fakeClient(Array.from({ length: nCalls }, () => router));
  return {
    db,
    rates,
    client,
    publish: async (_r, e) => events.push(e),
    fetchRules: async (_v, community) => {
      rulesFetched.push(String(community));
      return { url: `https://www.reddit.com/r/${community}/about/rules`, text: "1. No spam. 2. Say if you made it.", fetchedAt: new Date() };
    },
    adsKit: async (ctx) => {
      adsCalls.push(ctx);
      await db.update(schema.launchKits).set({ status: "ready", body: { schemaVersion: 1 } }).where(eq(schema.launchKits.id, ctx.kitId));
    },
  };
}

const kitRow = async (id: string) => (await db.select().from(schema.launchKits).where(eq(schema.launchKits.id, id)))[0]!;
const runRow = async (id: string) => (await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, id)))[0]!;

async function make(kinds: string[], inputs: KitInputs = {}) {
  const r = await createKitRun(db, ws, { launchPlanId: planId, kinds, inputs, userId: "cj" });
  return r!;
}

const goodReplies = {
  replies: [
    { trigger: "Is it a subscription?", reply: "Nope, it's $4.99 once.", claimRefs: [] },
    { trigger: "How fast is it?", reply: "About 15 seconds for a syllabus.", claimRefs: ["C1"] },
    { trigger: "Where do I get it?", reply: "I made it, it's here: {{link:landing}}", claimRefs: [] },
  ],
};

const goodAmbassador = {
  pitch: "Help classmates get every deadline in their calendar.",
  perks: ["[What you'll give ambassadors]"],
  templates: [1, 2, 3].map((i) => ({ channel: "dm", subject: null, text: `Hey [Name], I made SyllaCal. Want to share it at [Campus]? (${i})` })),
  postingGuide: ["Post once a week", "Start every caption with the disclosure"],
  captionExamples: [`${AMBASSADOR_CAPTION_PREFIX} Syllabus week, done.`, `${AMBASSADOR_CAPTION_PREFIX} My whole semester is in my calendar.`],
  claimRefs: [],
};

const pitches = Array.from({ length: 10 }, (_, i) => ({
  outletType: (["student_newsletter", "campus_paper", "podcast"] as const)[i % 3],
  outlet: "[Outlet]",
  subject: `A student-made app for syllabus week (${"abcdefghij"[i]})`,
  body: "Hi [Editor first name], I built SyllaCal because I kept missing deadlines. Happy to show you a demo.",
  claimRefs: [],
}));
const goodPress = {
  facts: [{ label: "Speed", value: "About 15 seconds per syllabus", claimRefs: ["C1"] }],
  boilerplate: "SyllaCal turns a syllabus PDF into calendar events.",
  founderQuote: "I built SyllaCal after syllabus week buried me.",
  pitches,
  assets: [{ assetId: "", label: "Upload screen" }],
  claimRefs: [],
};

describe("launch kit runs", () => {
  it("estimates and creates one kit per plan + kind, reusing rows on regenerate", async () => {
    const est = await planKitRun(db, ws, { launchPlanId: planId, kinds: ["reply_bank", "press"] });
    expect(est!.expected).toBe(90_000 + 150_000 + 40_000);
    expect(est!.launchDate).toBe("2027-01-19");
    expect(await planKitRun(db, uuidv7(), { launchPlanId: planId, kinds: ["press"] })).toBeNull();
    await expect(planKitRun(db, ws, { launchPlanId: planId, kinds: ["nope"] })).rejects.toThrow(/isn't a kind/);

    const a = await make(["reply_bank"]);
    const run = await runRow(a.runId);
    expect(run.kind).toBe("launch_kit");
    expect(run.status).toBe("queued");
    expect(run.capMicros).toBe(a.estimate.capMicros);
    const b = await make(["reply_bank"]);
    expect(b.kitIds).toEqual(a.kitIds);
    expect((await kitRow(b.kitIds[0]!)).runId).toBe(b.runId);
    // The first run's job finds its kit taken by the newer run and does nothing.
    await executeLaunchKit(deps(0), { runId: a.runId, kitId: a.kitIds[0]! });
    expect((await kitRow(a.kitIds[0]!)).status).toBe("planned");
  });

  it("reply bank: generated, checked and ready; run completes", async () => {
    const r = await make(["reply_bank"]);
    answers.reply_bank!.push(goodReplies);
    await executeLaunchKit(deps(1), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("ready");
    expect(k.disclosuresOk).toBe(true);
    expect(k.claimIds).toEqual(["C1"]);
    expect((k.body as unknown as ReplyBankBody).replies).toHaveLength(3);
    const run = await runRow(r.runId);
    expect(run.status).toBe("completed");
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["stage_started", "artifact_ready", "run_completed"]));
  });

  it("an invented number without a fact blocks, and one repair fixes it", async () => {
    const r = await make(["reply_bank"]);
    answers.reply_bank!.push({ replies: [{ trigger: "Does anyone use this?", reply: "Over 5000 students use it!", claimRefs: [] }] }, goodReplies);
    await executeLaunchKit(deps(2), { runId: r.runId, kitId: r.kitIds[0]! });
    expect((await kitRow(r.kitIds[0]!)).status).toBe("ready");
  });

  it("a number that stays unsourced after the repair is Needs you", async () => {
    const r = await make(["reply_bank"]);
    const bad = { replies: [{ trigger: "Does anyone use this?", reply: "Over 5000 students use it!", claimRefs: [] }] };
    answers.reply_bank!.push(bad, bad);
    await executeLaunchKit(deps(2), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("needs_you");
    expect(k.needsYouReason).toMatch(/number/);
    expect(k.issues.find((i) => i.code === "number_without_source")?.severity).toBe("block");
  });

  it("ambassador: a missing disclosure blocks, the repair still misses it → Needs you, and export refuses", async () => {
    const r = await make(["ambassador"], { ambassador: { ambassadors: [{ name: "Maya Chen", ref: null }], reward: null } });
    const noDisclosure = { ...goodAmbassador, captionExamples: ["Syllabus week, done. #ad"] };
    answers.ambassador!.push(noDisclosure, noDisclosure);
    await executeLaunchKit(deps(2), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("needs_you");
    expect(k.disclosuresOk).toBe(false);
    expect(k.needsYouReason).toMatch(/disclosure/);
    await expect(exportKit({ db, storage }, ws, k.id)).rejects.toThrow(/disclosure/);

    // The user fixes the caption in the UI: re-checked, disclosures recomputed, then it exports.
    const body = k.body as unknown as AmbassadorKitBody;
    expect(body.links[0]!.url).toBe("https://syllacal.com/go/maya-chen?utm_source=ambassador&utm_medium=referral&utm_campaign=syllacal-launch&utm_content=maya-chen");
    const saved = await saveKitBody(db, ws, k.id, { ...body, captionExamples: [`${AMBASSADOR_CAPTION_PREFIX} Syllabus week, done.`] }, "cj");
    expect(saved!.disclosuresOk).toBe(true);
    expect(saved!.status).toBe("ready");
    const out = await exportKit({ db, storage }, ws, k.id);
    expect(out.files).toEqual(["README.md", "pitch.md", "messages.md", "posting-guide.md", "links.csv"]);
    expect((await kitRow(k.id)).exportAssetId).toBe(out.assetId);
  });

  it("ambassador generated right the first time is ready with disclosures", async () => {
    const r = await make(["ambassador"], { ambassador: { ambassadors: [], reward: "A free Pro plan and $2 per signup" } });
    answers.ambassador!.push({ ...goodAmbassador, perks: ["A free Pro plan", "$2 for every signup"] });
    await executeLaunchKit(deps(1), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.issues.filter((i) => i.severity === "block")).toEqual([]);
    expect(k.disclosuresOk).toBe(true);
  });

  it("press: exact prices, placeholders, assets from the library; export zips files", async () => {
    const r = await make(["press"]);
    answers.press!.push({ ...goodPress, assets: [{ assetId: shotId, label: "Upload screen" }, { assetId: "made-up", label: "x" }] });
    await executeLaunchKit(deps(1), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("ready");
    expect(k.issues.map((i) => i.code)).toContain("edit_founder_quote");
    const body = k.body as { facts: { label: string; value: string }[]; assets: { assetId: string }[] };
    expect(body.facts.find((f) => f.label === "Price: Basic")?.value).toBe("$4.99 one-time");
    expect(body.assets.map((a) => a.assetId)).toEqual([shotId]);
    const out = await exportKit({ db, storage }, ws, k.id);
    expect(out.files).toEqual(expect.arrayContaining(["fact-sheet.md", "boilerplate.md", "founder-quote.md", "pitches/01-student-newsletter.md", "pitches/10-student-newsletter.md", "assets/01-upload-screen.png"]));
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, out.assetId));
    expect(asset!.mime).toBe("application/zip");
    const zip = new TextDecoder("latin1").decode(await storage.get(asset!.storageKey));
    expect(zip).toContain("fact-sheet.md");
    expect(zip).toContain("utm_source=press");
  });

  it("press: an invented outlet name blocks", async () => {
    const r = await make(["press"]);
    const bad = { ...goodPress, pitches: pitches.map((p) => ({ ...p, outlet: "The Daily Bruin" })) };
    answers.press!.push(bad, bad);
    await executeLaunchKit(deps(2), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("needs_you");
    expect(k.issues.map((i) => i.code)).toContain("invented_outlet");
  });

  it("subreddit: rules snapshotted, a Copy & open task per draft due on launch day", async () => {
    const r = await make(["subreddit"], { subreddit: { communities: ["college", "UCSD"], dueDate: null } });
    answers.subreddit!.push({
      drafts: ["college", "UCSD", "notchosen"].map((s) => ({
        subreddit: s,
        title: "I made an app that reads your syllabus",
        body: "I made this after missing a deadline. Try it: {{link:landing}}",
        whyThisFits: "Students here ask about planning.",
        bestTime: "Tuesday morning",
        claimRefs: [],
        likelyNotAllowed: false,
      })),
    });
    await executeLaunchKit(deps(1), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("ready");
    const body = k.body as unknown as SubredditKitBody;
    expect(body.drafts.map((d) => d.subreddit)).toEqual(["college", "UCSD"]);
    expect(body.assistedTaskIds).toHaveLength(2);
    expect(rulesFetched).toEqual(expect.arrayContaining(["college", "UCSD"]));
    const tasks = await db.select().from(schema.assistedTasks).where(eq(schema.assistedTasks.workspaceId, ws));
    const t = tasks.find((x) => x.id === body.assistedTaskIds[0])!;
    expect(t.venue).toBe("reddit/college");
    expect(t.rulesSnapshot).toContain("No spam");
    expect(t.rulesCheckedByHumanAt).toBeNull();
    expect(t.body).toContain("https://syllacal.com/?utm_source=reddit");
    expect(t.deepLink).toMatch(/^https:\/\/www\.reddit\.com\/r\/college\/submit\?/);
    expect(t.dueAt!.toISOString()).toBe("2027-01-19T15:00:00.000Z");

    const view = await kitView(db, ws, planId);
    const card = view!.kits.find((c) => c.kind === "subreddit")!;
    expect(card.assistedTasks).toHaveLength(2);
    expect(card.exportBlockedReason).toBeNull();

    // Regenerating skips the old drafts' open tasks; rules come from the ≤7-day snapshot.
    rulesFetched.length = 0;
    const again = await make(["subreddit"], { subreddit: { communities: ["college"], dueDate: "2027-01-20" } });
    const old = await db.select().from(schema.assistedTasks).where(eq(schema.assistedTasks.id, body.assistedTaskIds[0]!));
    expect(old[0]!.status).toBe("skipped");
    answers.subreddit!.push({ drafts: [{ subreddit: "college", title: "t", body: "I made this.", whyThisFits: "w", bestTime: "b", claimRefs: [], likelyNotAllowed: false }] });
    await executeLaunchKit(deps(1), { runId: again.runId, kitId: again.kitIds[0]! });
    expect(rulesFetched).toEqual([]);
  });

  it("creator brief: ready with the partnership label and branded content steps", async () => {
    const r = await make(["creator"], { creator: { offer: null } });
    answers.creator!.push({
      whatItIs: "SyllaCal reads a syllabus PDF and puts every deadline in your calendar.",
      whatToShow: ["Dropping a syllabus in", "The calendar filling up"],
      dos: ["Show your real semester"],
      donts: ["Promise better grades", "Hide the partnership"],
      dmTemplates: [1, 2, 3].map(() => ({ text: "Hi [Creator name], I made SyllaCal. I can offer [What you'll offer]. Posts need the paid partnership label." })),
      claimRefs: [],
    });
    await executeLaunchKit(deps(1), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("ready");
    expect(k.disclosuresOk).toBe(true);
  });

  it("a refusal is Needs you with the stop details kept (D15)", async () => {
    const r = await make(["creator"]);
    answers.creator!.push({ refuse: true });
    await executeLaunchKit(deps(1), { runId: r.runId, kitId: r.kitIds[0]! });
    const k = await kitRow(r.kitIds[0]!);
    expect(k.status).toBe("needs_you");
    expect(k.needsYouReason).toMatch(/declined/);
    const run = await runRow(r.runId);
    expect(run.result?.[`refusal:${k.id}`]).toEqual({ kind: "creator", stopDetails: { category: "test" } });
    expect(run.status).toBe("completed");
  });

  it("ads_export gets its own ads_kit run and goes to the injected ads module", async () => {
    adsCalls = [];
    const r = await make(["ads_export", "reply_bank"]);
    expect(r.runIds).toHaveLength(2);
    const ads = r.kits.find((k) => k.kind === "ads_export")!;
    const reply = r.kits.find((k) => k.kind === "reply_bank")!;
    expect(reply.runId).toBe(r.runId);
    expect(ads.runId).not.toBe(r.runId);
    const adsRun = await runRow(ads.runId);
    expect(adsRun.kind).toBe("ads_kit");
    expect(adsRun.capMicros).toBe(ADS_KIT_CAP_MICROS);
    expect((await runRow(r.runId)).capMicros).toBe(estimateKitRun(["reply_bank"]).capMicros);
    expect(r.estimate.capMicros).toBe(estimateKitRun(["reply_bank"]).capMicros + ADS_KIT_CAP_MICROS);

    // The launch_kit run's job never touches the ads kit.
    await executeLaunchKit(deps(0), { runId: r.runId, kitId: ads.kitId });
    expect(adsCalls).toHaveLength(0);
    await executeLaunchKit(deps(0), { runId: ads.runId, kitId: ads.kitId });
    expect(adsCalls.map((c) => [c.kitId, c.runId, c.workspaceId])).toEqual([[ads.kitId, ads.runId, ws]]);
    expect((await kitRow(ads.kitId)).status).toBe("ready");
    answers.reply_bank!.push(goodReplies);
    await executeLaunchKit(deps(1), { runId: r.runId, kitId: reply.kitId });
    expect((await runRow(r.runId)).status).toBe("completed");
  });

  it("without the ads module the ads kit is Needs you and its run fails", async () => {
    const r = await make(["ads_export"]);
    const { adsKit: _drop, ...noAds } = deps(0);
    await executeLaunchKit(noAds, { runId: r.runId, kitId: r.kitIds[0]! });
    expect((await kitRow(r.kitIds[0]!)).status).toBe("needs_you");
    expect((await runRow(r.runId)).status).toBe("failed");
    // Its download goes through the ads module's export, which refuses a kit that isn't ready.
    await expect(exportKit({ db, storage }, ws, r.kitIds[0]!)).rejects.toThrow(/Fix this first|isn't ready/);
  });

  it("saveKitBody re-checks edits (prices exact) and refuses other workspaces", async () => {
    const view = await kitView(db, ws, planId);
    const reply = view!.kits.find((c) => c.kind === "reply_bank")!;
    const body = reply.body as unknown as ReplyBankBody;
    const saved = await saveKitBody(db, ws, reply.id, { ...body, replies: [{ trigger: "Price?", reply: "It's $3.99.", claimRefs: [] }] }, "cj");
    expect(saved!.status).toBe("needs_you");
    expect(saved!.issues.map((i) => i.code)).toContain("price_not_exact");
    await expect(exportKit({ db, storage }, ws, reply.id)).rejects.toThrow(/Fix this first/);
    expect(await saveKitBody(db, uuidv7(), reply.id, body, "cj")).toBeNull();
    await expect(saveKitBody(db, ws, reply.id, { kind: "reply_bank" }, "cj")).rejects.toThrow(/isn't filled in right/);
  });
});
