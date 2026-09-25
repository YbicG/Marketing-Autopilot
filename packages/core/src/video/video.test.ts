import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { SpecIssue, VideoSpec } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { fakeClient, jsonReply, type FakeReply } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import type { AudioOps, VideoDeps } from "./deps.ts";
import {
  confirmFinalize,
  executeFinalize,
  executeRenderVideo,
  FinalizeNotConfirmed,
  finalizeHash,
  platformPlan,
  rerenderHook,
} from "./finalize.ts";
import { latestSpec } from "./spec.ts";
import { fakeAudio, fakeRenderer, fakeTools, memoryStorage, scriptReply, seedVideoWorld, specReply, type VideoWorld } from "./testing.ts";
import { executeRenderStill } from "./stills.ts";
import { ingestUpload, UploadRejected } from "./uploads.ts";
import { runVideoItem, saveVideoEdit } from "./video-item.ts";
import { transitionVideoItem } from "./video-item-state.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
});
afterAll(async () => {
  await close();
});

const sys = (p: Record<string, unknown>) => String(p.system);

/** Answers by system prompt; `script`/`spec` let a test hand in bad first answers. */
function claude(w: VideoWorld, opts: { scripts?: unknown[]; specs?: unknown[] } = {}) {
  const scripts = [...(opts.scripts ?? [])];
  const specs = [...(opts.specs ?? [])];
  const route: FakeReply = (p) => {
    const s = sys(p);
    if (s.startsWith("You write short vertical videos")) return jsonReply(scripts.shift() ?? scriptReply(w.shotId));
    if (s.startsWith("You turn a short video script")) return jsonReply(specs.shift() ?? specReply(w.shotId, scriptReply(w.shotId)));
    if (s.startsWith("You check a finished")) return jsonReply({ issues: [], personalData: [] });
    if (s.startsWith("You review a short product video")) {
      return jsonReply({
        hooks: [0, 1, 2].map((hookIdx) => ({ hookIdx, propositionBy3s: true, openingBy6s: true, brandEarly: true, lastLineSpoken: true, lastLineOnScreen: true, honest: true, note: "" })),
        pairwise: [{ a: 0, b: 1, better: 1 }, { a: 0, b: 2, better: 2 }, { a: 1, b: 2, better: 1 }],
      });
    }
    throw new Error(`unexpected call: ${s.slice(0, 60)}`);
  };
  return fakeClient(Array.from({ length: 60 }, () => route));
}

interface Harness {
  deps: VideoDeps;
  audio: ReturnType<typeof fakeAudio>;
  calls: Record<string, unknown>[];
  queued: string[];
  voided: { ids: string[]; reason: string }[];
  renderer: ReturnType<typeof fakeRenderer>;
}

function harness(w: VideoWorld, opts: { lint?: (spec: VideoSpec) => SpecIssue[]; hear?: (t: string, take: number) => string; scripts?: unknown[]; specs?: unknown[]; audio?: AudioOps | null } = {}): Harness {
  const audio = fakeAudio(opts.hear ? { hear: opts.hear } : {});
  const { client, calls } = claude(w, opts);
  const queued: string[] = [];
  const voided: { ids: string[]; reason: string }[] = [];
  const renderer = fakeRenderer();
  const deps: VideoDeps = {
    db,
    rates,
    storage: memoryStorage({ [w.shotKey]: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
    client,
    audio: opts.audio === undefined ? audio : opts.audio,
    providerCtx: { secret: async () => "k" },
    renderer,
    tools: fakeTools(opts.lint),
    voidApprovalsFor: async (ids, reason) => {
      voided.push({ ids, reason });
    },
    enqueueRender: async (id) => {
      queued.push(id);
    },
    defaultVoiceId: "v1",
  };
  return { deps, audio, calls, queued, voided, renderer };
}

const item = async (w: VideoWorld) => (await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, w.itemId)))[0]!;
const featureCalls = (calls: Record<string, unknown>[], start: string) => calls.filter((c) => String(c.system).startsWith(start)).length;

describe("script → spec → draft voice", () => {
  it("writes a script and a spec with fake Claude, keeps only public claims and real footage", async () => {
    const w = await seedVideoWorld(db);
    const h = harness(w);
    await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
    expect((await item(w)).status).toBe("ready");
    const row = (await latestSpec(db, w.ws, w.itemId))!;
    const script = row.script as { claimRefs: string[]; assetRefs: string[] };
    expect(script.claimRefs).toEqual(["C1"]);
    expect(script.assetRefs).toEqual([w.shotId]);
    const spec = row.spec as unknown as VideoSpec;
    expect(spec.hookVariants.map((x) => x.style)).toEqual(["pain_callout", "speed_demo", "pov"]);
    expect(spec.voice).toEqual({ voiceId: "v1", model: "draft" });
    expect(featureCalls(h.calls, "You write short vertical videos")).toBe(1);
    expect(featureCalls(h.calls, "You turn a short video script")).toBe(1);
    // Draft voice: 3 opening lines + 2 scenes + the last line, all on the draft model.
    expect(h.audio.calls.tts).toHaveLength(6);
    expect(h.audio.calls.tts.every((c) => c.quality === "draft")).toBe(true);
  });

  it("repairs a script with repeated opening-line styles once", async () => {
    const w = await seedVideoWorld(db);
    const bad = scriptReply(w.shotId);
    bad.hooks = bad.hooks.map((x) => ({ ...x, style: "pov" as const }));
    const h = harness(w, { scripts: [bad] });
    await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
    expect(featureCalls(h.calls, "You write short vertical videos")).toBe(2);
    expect((await item(w)).status).toBe("ready");
  });

  it("repairs a spec that fails lint once, then sends it to Needs you", async () => {
    const w1 = await seedVideoWorld(db);
    let n = 0;
    const once = harness(w1, { lint: () => (n++ === 0 ? [{ code: "wps", message: "Scene s1 talks too fast.", severity: "block" }] : []) });
    await runVideoItem(once.deps, w1.runId, w1.ws, w1.itemId);
    expect(featureCalls(once.calls, "You turn a short video script")).toBe(2);
    expect((await item(w1)).status).toBe("ready");

    const w2 = await seedVideoWorld(db);
    const always = harness(w2, { lint: () => [{ code: "wps", message: "Scene s1 talks too fast.", severity: "block" }] });
    await runVideoItem(always.deps, w2.runId, w2.ws, w2.itemId);
    expect(featureCalls(always.calls, "You turn a short video script")).toBe(2);
    const it2 = await item(w2);
    expect(it2.status).toBe("needs_you");
    expect(it2.needsYouReason).toContain("talks too fast");
    expect(always.audio.calls.tts).toHaveLength(0);
  });

  it("without a voice key makes the captions-only cut", async () => {
    const w = await seedVideoWorld(db);
    const h = harness(w, { audio: null });
    await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
    expect((await item(w)).status).toBe("ready");
    const meta = (await latestSpec(db, w.ws, w.itemId))!.lint as { noVoice?: boolean };
    expect(meta.noVoice).toBe(true);
  });
});

describe("TTS cache", () => {
  it("editing one line makes exactly one TTS call", async () => {
    const w = await seedVideoWorld(db);
    const h = harness(w);
    await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
    expect(h.audio.calls.tts).toHaveLength(6);
    const spec = (await latestSpec(db, w.ws, w.itemId))!.spec as unknown as VideoSpec;
    const edited: VideoSpec = { ...spec, scenes: spec.scenes.map((s) => (s.id === "s2" ? { ...s, vo: "Every single deadline lands in your calendar." } : s)) };
    await saveVideoEdit(h.deps, { runId: w.runId, workspaceId: w.ws, contentItemId: w.itemId, spec: edited });
    expect(h.audio.calls.tts).toHaveLength(7);
    expect(h.audio.calls.tts[6]!.text).toBe("Every single deadline lands in your calendar.");
    // Whitespace-only change: cache hit.
    const again: VideoSpec = { ...edited, cta: { ...edited.cta, vo: `  ${edited.cta.vo}  ` } };
    await saveVideoEdit(h.deps, { runId: w.runId, workspaceId: w.ws, contentItemId: w.itemId, spec: again });
    expect(h.audio.calls.tts).toHaveLength(7);
  });
});

async function readyItem(w: VideoWorld, opts: Parameters<typeof harness>[1] = {}) {
  const h = harness(w, opts);
  await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
  const spec = (await latestSpec(db, w.ws, w.itemId))!.spec as unknown as VideoSpec;
  return { h, spec };
}

async function renderAll(h: Harness) {
  while (h.queued.length) await executeRenderVideo(h.deps, h.queued.shift()!);
}

describe("Finalize gate", () => {
  it("needs a confirmation keyed on the spec; changing an opening line invalidates it", async () => {
    const w = await seedVideoWorld(db);
    const { h, spec } = await readyItem(w);
    const job = { runId: w.runId, contentItemId: w.itemId, workspaceId: w.ws };
    await expect(executeFinalize(h.deps, job)).rejects.toBeInstanceOf(FinalizeNotConfirmed);
    await expect(confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: "stale" })).rejects.toBeInstanceOf(FinalizeNotConfirmed);

    const { finalizeHash: hash } = await confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: finalizeHash(spec) });
    expect(hash).toBe(finalizeHash(spec));
    // Voice model "draft" vs "final" doesn't change the key; the opening lines do.
    expect(finalizeHash({ ...spec, voice: { ...spec.voice, model: "final" } })).toBe(hash);
    const changed: VideoSpec = { ...spec, hookVariants: spec.hookVariants.map((x, i) => (i === 0 ? { ...x, onScreen: "Typing deadlines again?" } : x)) };
    expect(finalizeHash(changed)).not.toBe(hash);

    await saveVideoEdit(h.deps, { runId: w.runId, workspaceId: w.ws, contentItemId: w.itemId, spec: changed });
    await expect(executeFinalize(h.deps, job)).rejects.toBeInstanceOf(FinalizeNotConfirmed);
    expect(h.queued).toHaveLength(0);

    await confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: finalizeHash(changed) });
    await executeFinalize(h.deps, job);
    expect(h.queued).toHaveLength(3);
    expect((await item(w)).status).toBe("finalizing");
    // Final voice on the final model; music generated once for the longest timeline.
    expect(h.audio.calls.tts.filter((c) => c.quality === "final")).toHaveLength(6);
    expect(h.audio.calls.music).toBe(1);
  });

  it("renders 3 opening lines, runs QA and writes one variant per platform", async () => {
    const w = await seedVideoWorld(db);
    const { h, spec } = await readyItem(w);
    await confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: finalizeHash(spec) });
    await executeFinalize(h.deps, { runId: w.runId, contentItemId: w.itemId, workspaceId: w.ws });
    await renderAll(h);
    expect((await item(w)).status).toBe("final_ready");
    const vs = await db.select().from(schema.variants).where(eq(schema.variants.contentItemId, w.itemId));
    expect(vs.map((v) => [v.platform, v.hookIdx]).sort()).toEqual([["instagram", 1], ["tiktok", 0], ["youtube", 2]]);
    expect(vs.every((v) => v.provenanceTier === "B")).toBe(true); // TTS + generated music (D18)
    expect(h.renderer.calls.writeXmp).toBe(15);
    expect(featureCalls(h.calls, "You check a finished")).toBe(3);
    expect(featureCalls(h.calls, "You review a short product video")).toBe(1);
  });

  it("a re-render after approval voids the approval", async () => {
    const w = await seedVideoWorld(db);
    const { h, spec } = await readyItem(w);
    await confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: finalizeHash(spec) });
    await executeFinalize(h.deps, { runId: w.runId, contentItemId: w.itemId, workspaceId: w.ws });
    await renderAll(h);
    await db.update(schema.contentItems).set({ status: "approved" }).where(eq(schema.contentItems.id, w.itemId));
    const vs = await db.select().from(schema.variants).where(eq(schema.variants.contentItemId, w.itemId));
    expect(h.voided).toHaveLength(0);

    await rerenderHook(h.deps, { workspaceId: w.ws, contentItemId: w.itemId, hookIdx: 1 });
    expect(h.voided).toHaveLength(1);
    expect(h.voided[0]!.ids.sort()).toEqual(vs.map((v) => v.id).sort());
    expect((await item(w)).status).toBe("finalizing");
    await renderAll(h);
    expect((await item(w)).status).toBe("final_ready");
  });

  it("the state machine flags every change after final_ready", () => {
    expect(transitionVideoItem("approved", "edit")).toEqual({ next: "ready", voidApproval: true });
    expect(transitionVideoItem("final_ready", "revoice").voidApproval).toBe(true);
    expect(transitionVideoItem("ready", "edit").voidApproval).toBe(false);
    expect(() => transitionVideoItem("planned", "approve")).toThrow();
  });
});

describe("QA stage 1 (transcript)", () => {
  const misheard = (bad: string) => (t: string) => (t.startsWith("Drop your") ? bad : t);

  it("re-voices a misheard line, at most 2 takes, then Needs you", async () => {
    const w = await seedVideoWorld(db);
    const { h, spec } = await readyItem(w, { hear: misheard("Stop your silly bus") });
    await confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: finalizeHash(spec) });
    await executeFinalize(h.deps, { runId: w.runId, contentItemId: w.itemId, workspaceId: w.ws });
    const finals = h.audio.calls.tts.filter((c) => c.quality === "final" && c.text.startsWith("Drop your"));
    expect(finals).toHaveLength(2);
    const it1 = await item(w);
    expect(it1.status).toBe("needs_you");
    expect(it1.needsYouReason).toContain("after 2 takes");
    expect(h.queued).toHaveLength(0);
  });

  it("a second take that is heard right passes", async () => {
    const w = await seedVideoWorld(db);
    const { h, spec } = await readyItem(w, { hear: (t, take) => (t.startsWith("Drop your") && take === 1 ? "Stop your silly bus" : t) });
    await confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: finalizeHash(spec) });
    await executeFinalize(h.deps, { runId: w.runId, contentItemId: w.itemId, workspaceId: w.ws });
    expect(h.queued).toHaveLength(3);
    const seg = await db.select().from(schema.ttsSegments).where(and(eq(schema.ttsSegments.workspaceId, w.ws), eq(schema.ttsSegments.model, "eleven_v3")));
    expect(seg.every((s) => s.werBp !== null && s.werBp <= 500)).toBe(true);
  });
});

describe("platformPlan", () => {
  it("gives each platform one opening line in brief order", () => {
    expect(platformPlan({ targets: [{ platform: "youtube" }, { platform: "linkedin" }, { platform: "youtube" }] }, 3)).toEqual([
      { platform: "youtube", hookIdx: 0, file: "yt_short" },
      { platform: "linkedin", hookIdx: 1, file: "master" },
    ]);
    expect(platformPlan(null, 3).map((p) => p.platform)).toEqual(["tiktok", "instagram", "youtube"]);
  });
});

describe("footage upload", () => {
  it("stores a sniffed recording content-addressed and dedupes the same bytes", async () => {
    const w = await seedVideoWorld(db);
    const h = harness(w);
    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]);
    const a = await ingestUpload(h.deps, { workspaceId: w.ws, productId: w.productId, bytes: mp4, filename: "demo sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.mov" });
    expect(a).toMatchObject({ kind: "recording", created: true, durationMs: 30_000 });
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, a.assetId));
    expect(row!.storageKey).toMatch(new RegExp(`^ws/${w.ws}/assets/[0-9a-f]{64}\.mp4$`));
    expect(row!.origin).toBe("uploaded");
    expect(row!.provenanceTier).toBe("A");
    expect(String(row!.origination.filename)).not.toContain("sk-ant-api03");
    const again = await ingestUpload(h.deps, { workspaceId: w.ws, productId: w.productId, bytes: mp4, filename: "x.mp4" });
    expect(again).toMatchObject({ assetId: a.assetId, created: false });
    await expect(ingestUpload(h.deps, { workspaceId: w.ws, productId: w.productId, bytes: new TextEncoder().encode("MZ-not-a-video-file"), filename: "a.mp4" })).rejects.toBeInstanceOf(UploadRejected);
  });
});

describe("render.still", () => {
  it("renders a swipe post per platform: IG JPEGs, a LinkedIn PDF", async () => {
    const w = await seedVideoWorld(db);
    const h = harness(w);
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
    const make = async (platform: string, format: string) => {
      const id = uuidv7();
      await db.insert(schema.variants).values({ id, workspaceId: w.ws, contentItemId: w.itemId, platform, body: { schemaVersion: 1, kind: "carousel", format, spec, caption: { text: "x", hashtags: [] }, renderedAssetIds: [] }, contentHash: "h0" });
      return id;
    };
    const ig = await make("instagram", "carousel");
    const li = await make("linkedin", "document");
    const a = await executeRenderStill(h.deps, { contentItemId: w.itemId, variantId: ig });
    expect(a!.assetIds).toHaveLength(3);
    const b = await executeRenderStill(h.deps, { contentItemId: w.itemId, variantId: li });
    expect(b!.assetIds).toHaveLength(1);
    const [pdf] = await db.select().from(schema.assets).where(eq(schema.assets.id, b!.assetIds[0]!));
    expect(pdf!.kind).toBe("pdf");
    const [v] = await db.select().from(schema.variants).where(eq(schema.variants.id, ig));
    expect(v!.assetIds).toEqual(a!.assetIds);
    expect((v!.body as { renderedAssetIds: string[] }).renderedAssetIds).toEqual(a!.assetIds);
    expect(v!.contentHash).not.toBe("h0");
    expect(h.renderer.calls.renderStillImage).toBe(6);
    // Re-render with the same slides: same files, same hash, nothing voided.
    await executeRenderStill(h.deps, { contentItemId: w.itemId, variantId: ig });
    expect(h.voided).toHaveLength(0);
  });
});
