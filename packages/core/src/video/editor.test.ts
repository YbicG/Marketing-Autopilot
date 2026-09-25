import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { VideoSpec } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { createVideoActionRun, ensureVideoPosts, finishVideoActionRun, openingLineChecks, rankOpeningLines, videoEditorView } from "./editor.ts";
import { seedVideoWorld, type VideoWorld } from "./testing.ts";

const hooks = (...xs: [string, string][]) => ({ hookVariants: xs.map(([onScreen, vo]) => ({ onScreen, vo })) }) as unknown as Pick<VideoSpec, "hookVariants">;

describe("opening line checks", () => {
  it("flags empty, long and too-fast lines, and only measures voiced text that still matches", () => {
    const spec = hooks(["Syllabus to calendar", "Your syllabus becomes a calendar"], ["", "four words right here"], ["x".repeat(61), "one two three four five six seven eight nine ten"]);
    const checks = openingLineChecks(spec, {
      "hook:0": { text: "Your syllabus becomes a calendar", durationMs: 2000 },
      "hook:1": { text: "something else", durationMs: 1000 },
      "hook:2": { text: "one two three four five six seven eight nine ten", durationMs: 2000 },
    });
    expect(checks[0]).toEqual({ idx: 0, wps: 2.5, problems: [] });
    expect(checks[1]!.wps).toBeNull();
    expect(checks[1]!.problems).toContain("It has no on-screen text.");
    expect(checks[2]!.wps).toBe(5);
    expect(checks[2]!.problems).toHaveLength(2);
  });

  it("ranks by the judge only when its ranking is a valid permutation", () => {
    const spec = hooks(["aaaa", "v"], ["a", "v"], ["aa", "v"]);
    const checks = [0, 1, 2].map((idx) => ({ idx, wps: null, problems: idx === 1 ? ["x"] : [] }));
    expect(rankOpeningLines(spec, checks)).toEqual({ order: [2, 0, 1], source: "checks" });
    expect(rankOpeningLines(spec, checks, [1, 2, 0])).toEqual({ order: [1, 2, 0], source: "judge" });
    expect(rankOpeningLines(spec, checks, [1, 1, 0]).source).toBe("checks");
  });
});

describe("editor read model and helpers", () => {
  let db: Db;
  let close: () => Promise<void>;
  let w: VideoWorld;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    w = await seedVideoWorld(db);
  });
  afterAll(async () => close());

  it("reads an item with no spec yet, and refuses another workspace", async () => {
    const view = await videoEditorView(db, w.ws, w.itemId);
    expect(view.spec).toBeNull();
    expect(view.item.productId).toBe(w.productId);
    expect(view.footage.map((f) => f.id)).toContain(w.shotId);
    await expect(videoEditorView(db, uuidv7(), w.itemId)).rejects.toThrow();
  });

  it("creates and closes action runs", async () => {
    const runId = await createVideoActionRun(db, { workspaceId: w.ws, contentItemId: w.itemId, action: "hooks_more", capMicros: 100_000 });
    await finishVideoActionRun(db, w.ws, runId, true, "done");
    const [r] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(r).toMatchObject({ kind: "refill", status: "completed", capMicros: 100_000 });
    const fin = await createVideoActionRun(db, { workspaceId: w.ws, contentItemId: w.itemId, action: "finalize", capMicros: 1 });
    const [f] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, fin));
    expect(f).toMatchObject({ kind: "finalize", status: "running" });
  });

  it("adds one pending post per final video variant with a slot, once", async () => {
    const slotId = "slot-1";
    const at = "2026-10-05T15:00:00.000Z";
    await db
      .update(schema.campaigns)
      .set({ plan: { slots: [{ id: slotId, platform: "tiktok", scheduledAt: at, connectionId: null }], items: [] } })
      .where(eq(schema.campaigns.id, w.campaignId));
    await db
      .update(schema.contentItems)
      .set({ brief: { schemaVersion: 1, targets: [{ platform: "tiktok", format: "video" }, { platform: "youtube", format: "video" }], slotIds: [slotId] } })
      .where(eq(schema.contentItems.id, w.itemId));
    for (const platform of ["tiktok", "youtube"]) {
      await db.insert(schema.variants).values({ id: uuidv7(), workspaceId: w.ws, contentItemId: w.itemId, platform, body: { kind: "video" }, assetIds: [w.shotId], contentHash: `h-${platform}` });
    }
    const first = await ensureVideoPosts(db, w.ws, w.itemId);
    expect(first.postIds).toHaveLength(1);
    expect(first.unscheduled).toEqual(["youtube"]);
    const again = await ensureVideoPosts(db, w.ws, w.itemId);
    expect(again.postIds).toEqual(first.postIds);
    const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, first.postIds[0]!));
    expect(p).toMatchObject({ state: "pending_approval", platform: "tiktok" });
    expect(p!.scheduledAt.toISOString()).toBe(at);
    expect((await ensureVideoPosts(db, uuidv7(), w.itemId)).postIds).toEqual([]);
  });
});
