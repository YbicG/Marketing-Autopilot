import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { approvePosts, uiSessionFromCookie } from "./approvals.ts";
import { scheduleEffects } from "./scheduler.ts";
import { approveFinishedVideos, cancelPost, PostActionError, postNow, reschedulePost, setMadeForKids } from "./ui-actions.ts";
import { approvalCounts, assistedCards, postDetail, postDownloadFiles, storeWebhookEvent, webhookWorkspaceHint, yesterdayNumbers } from "./screens.ts";
import { addDays, dayBounds, localTime, mondayOf, moveToDay, zonedTime } from "./zoned.ts";
import { crc32, zipStore } from "./zip.ts";
import { addPost, fakeAdapter, seedWorkspace, testDeps, type Seeded } from "./test-fixtures.ts";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const TZ = "America/New_York";
const SLOT = new Date("2026-10-20T23:30:00Z"); // Tue 7:30 pm New York
const NOW = new Date("2026-10-19T12:00:00Z");
const USER = { type: "user" as const, id: "user-1" };
const session = (s: Seeded) => uiSessionFromCookie({ userId: "user-1", workspaceId: s.workspaceId, originChecked: true, csrfChecked: true });

async function getPost(id: string) {
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, id));
  return p!;
}

async function queued(s: Seeded, at: Date) {
  const id = await addPost(db, s, at);
  const r = await approvePosts(db, session(s), [id], { now: NOW });
  expect(r.skipped).toEqual([]);
  return id;
}

describe("zoned time", () => {
  it("converts local wall-clock times in a zone, across DST", () => {
    expect(zonedTime("2026-10-20", "19:30", TZ).toISOString()).toBe("2026-10-20T23:30:00.000Z");
    expect(zonedTime("2026-12-01", "19:30", TZ).toISOString()).toBe("2026-12-02T00:30:00.000Z");
    expect(zonedTime("2026-11-01", "12:00", TZ).toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(localTime(SLOT, TZ)).toBe("19:30");
    expect(() => zonedTime("2026-10-20", "25:00", TZ)).toThrow("Pick a day and a time.");
  });

  it("moves a post to another day at the same local time, even over the DST change", () => {
    expect(moveToDay(SLOT, "2026-11-03", TZ).toISOString()).toBe("2026-11-04T00:30:00.000Z");
  });

  it("does calendar arithmetic", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect(mondayOf("2026-10-19")).toBe("2026-10-19");
    const b = dayBounds("2026-10-20", TZ);
    expect(b.from.toISOString()).toBe("2026-10-20T04:00:00.000Z");
    expect(b.to.toISOString()).toBe("2026-10-21T04:00:00.000Z");
  });
});

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a stored archive with local headers, central directory and end record", () => {
    const data = new TextEncoder().encode("hello");
    const z = zipStore([{ name: "a.txt", data }, { name: "b.txt", data }]);
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const cdOffset = v.getUint32(end + 16, true);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(cdOffset).toBe(2 * (30 + 5 + 5));
  });
});

describe("reschedule, post now, cancel", () => {
  it("moves a queued post and its delayed job, keeping the approval", async () => {
    const s = await seedWorkspace(db);
    const id = await queued(s, SLOT);
    const before = await getPost(id);
    const at = moveToDay(SLOT, "2026-10-22", TZ);
    const r = await reschedulePost(db, s.workspaceId, id, at, USER, { now: NOW });
    expect(r.effects).toEqual([{ type: "addDelayedJob", jobId: `pst_${id}_g1`, postId: id, generation: 1, runAt: at }]);
    const p = await getPost(id);
    expect(p.state).toBe("queued");
    expect(p.approvalId).toBe(before.approvalId);
    expect(p.scheduledAt.toISOString()).toBe(at.toISOString());
  });

  it("refuses the past and cap-breaking moves", async () => {
    const s = await seedWorkspace(db);
    const id = await queued(s, SLOT);
    await expect(reschedulePost(db, s.workspaceId, id, new Date(NOW.getTime() - 1000), USER, { now: NOW })).rejects.toThrow("Pick a time in the future.");

    const day = "2026-10-23";
    await queued(s, zonedTime(day, "09:00", TZ));
    await queued(s, zonedTime(day, "12:00", TZ));
    const err = await reschedulePost(db, s.workspaceId, id, zonedTime(day, "08:00", TZ), USER, { now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostActionError);
    expect((err as Error).message).toMatch(/Pick another day/);
    expect((await getPost(id)).scheduledAt.toISOString()).toBe(SLOT.toISOString());
  });

  it("reschedules and posts now from missed", async () => {
    const s = await seedWorkspace(db);
    const a = await addPost(db, s, SLOT, { state: "missed" });
    const b = await addPost(db, s, SLOT, { state: "missed", idempotencyKey: `pst_${uuidv7()}_g1` });
    const at = zonedTime("2026-10-21", "10:00", TZ);
    const r = await reschedulePost(db, s.workspaceId, a, at, USER, { now: NOW });
    expect(r.effects.map((e) => e.type)).toEqual(["addDelayedJob"]);
    expect((await getPost(a)).state).toBe("queued");

    const n = await postNow(db, s.workspaceId, b, USER, { now: NOW });
    expect(n.effects).toEqual([expect.objectContaining({ type: "addDelayedJob", runAt: NOW })]);
    expect((await getPost(b)).state).toBe("queued");
    await expect(postNow(db, s.workspaceId, b, USER, { now: NOW })).rejects.toThrow(PostActionError);
  });

  it("cancels before sending and refuses after", async () => {
    const s = await seedWorkspace(db);
    const id = await queued(s, SLOT);
    const r = await cancelPost(db, s.workspaceId, id, USER, { now: NOW });
    expect(r.effects).toEqual([{ type: "removeDelayedJob", jobId: `pst_${id}_g1` }]);
    expect((await getPost(id)).state).toBe("canceled");
    const sent = await addPost(db, s, SLOT, { state: "submitted", idempotencyKey: `pst_${uuidv7()}_g1` });
    await expect(cancelPost(db, s.workspaceId, sent, USER, { now: NOW })).rejects.toThrow("can't be canceled");
  });
});

describe("approve finished videos and counts", () => {
  it("approves only posts of final_ready videos and marks the videos approved", async () => {
    const s = await seedWorkspace(db);
    await db.update(schema.contentItems).set({ kind: "video", status: "final_ready" }).where(eq(schema.contentItems.id, s.contentItemId));
    const v = await addPost(db, s, SLOT);
    const past = await addPost(db, s, new Date(NOW.getTime() - 3_600_000));
    const other = await seedWorkspace(db, { workspaceId: s.workspaceId });
    const text = await addPost(db, other, SLOT);

    const counts = await approvalCounts(db, s.workspaceId, { productId: s.productId, now: NOW });
    expect(counts).toEqual({ nextDays: 1, finishedVideos: 1, waiting: 2, paused: 0 });

    const r = await approveFinishedVideos(db, session(s), { now: NOW });
    expect(r.approved.map((a) => a.postId)).toEqual([v]);
    expect((await getPost(v)).state).toBe("queued");
    expect((await getPost(past)).state).toBe("pending_approval");
    expect((await getPost(text)).state).toBe("pending_approval");
    const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, s.contentItemId));
    expect(item!.status).toBe("approved");
  });
});

describe("screens", () => {
  it("builds the post drawer and the download list", async () => {
    const s = await seedWorkspace(db);
    const id = await addPost(db, s, SLOT);
    const d = (await postDetail(db, s.workspaceId, id))!;
    expect(d).toMatchObject({
      platform: "threads",
      state: "pending_approval",
      slot: "Tue 7:30 pm",
      day: "2026-10-20",
      time: "19:30",
      canAutoPost: true,
      tier: "A",
      promotional: true,
      approvedAt: null,
    });
    expect(d.media).toEqual([expect.objectContaining({ assetId: s.assetId, filename: "threads-1.png" })]);
    expect(await postDetail(db, uuidv7(), id)).toBeNull();

    const dl = (await postDownloadFiles(db, s.workspaceId, id))!;
    expect(dl.files).toEqual([expect.objectContaining({ name: "threads-1.png", mime: "image/png" })]);
    await db.update(schema.posts).set({ connectionId: null }).where(eq(schema.posts.id, id));
    expect((await postDetail(db, s.workspaceId, id))!.canAutoPost).toBe(false);
  });

  it("lists Copy & open tasks with the rules state and a content-only deep link", async () => {
    const s = await seedWorkspace(db);
    await db.insert(schema.assistedTasks).values({
      id: uuidv7(),
      workspaceId: s.workspaceId,
      productId: s.productId,
      venue: "hackernews",
      title: "Show HN: SyllaCal",
      body: "Turns a syllabus into a calendar",
      rulesUrl: "https://news.ycombinator.com/showhn.html",
      rulesFetchedAt: new Date("2026-09-24T12:00:00Z"),
    });
    const cards = await assistedCards(db, s.workspaceId, { productId: s.productId, now: NOW });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ venue: "hackernews", rulesFetched: "Sep 24", rulesCheckedToday: false });
    expect(cards[0]!.postingUrl).toContain("news.ycombinator.com/submitlink");
  });

  it("sums yesterday's latest snapshots and signups", async () => {
    const s = await seedWorkspace(db);
    const now = new Date("2026-10-21T15:00:00Z");
    const id = await addPost(db, s, SLOT, { state: "published", publishedAt: SLOT });
    await db.insert(schema.analyticsSnapshots).values([
      { id: uuidv7(), workspaceId: s.workspaceId, postId: id, window: "h24", ageHours: 24, mature: false, metrics: { views: 100, likes: 3, linkClicks: null }, source: "t" },
      { id: uuidv7(), workspaceId: s.workspaceId, postId: id, window: "h72", ageHours: 72, mature: true, metrics: { views: 250, likes: 9, linkClicks: null }, source: "t" },
    ]);
    await db.insert(schema.conversionSnapshots).values({ id: uuidv7(), workspaceId: s.workspaceId, productId: s.productId, day: "2026-10-20", signups: 4 });
    expect(await yesterdayNumbers(db, s.workspaceId, s.productId, now)).toEqual({
      posts: 1,
      views: 250,
      likes: 9,
      comments: null,
      linkClicks: null,
      signups: 4,
    });
    expect(await yesterdayNumbers(db, s.workspaceId, s.productId, new Date("2026-10-25T15:00:00Z"))).toBeNull();
  });

  it("sets made-for-kids once per project, workspace-scoped", async () => {
    const s = await seedWorkspace(db);
    await setMadeForKids(db, s.workspaceId, s.productId, false, "user-1");
    const [p] = await db.select().from(schema.products).where(eq(schema.products.id, s.productId));
    expect(p!.madeForKids).toBe(false);
    await expect(setMadeForKids(db, uuidv7(), s.productId, true, "user-1")).rejects.toThrow("Project not found.");
  });
});

describe("webhook storage", () => {
  it("finds the workspace from external_id or profile and dedupes by event id", async () => {
    const s = await seedWorkspace(db);
    const id = await addPost(db, s, SLOT);
    expect(await webhookWorkspaceHint(db, JSON.stringify({ external_id: `pst_${id}_g1` }))).toBe(s.workspaceId);
    expect(await webhookWorkspaceHint(db, JSON.stringify({ external_id: `pst_${id}_g2` }))).toBe(s.workspaceId);
    expect(await webhookWorkspaceHint(db, JSON.stringify({ profile_username: `prof_${s.connectionId}` }))).toBe(s.workspaceId);
    expect(await webhookWorkspaceHint(db, "not json")).toBeNull();

    const row = { provider: "upload_post", eventId: `evt-${id}`, type: "upload_completed", body: "{}", workspaceId: s.workspaceId };
    const a = await storeWebhookEvent(db, row);
    expect(a.duplicate).toBe(false);
    const b = await storeWebhookEvent(db, row);
    expect(b).toEqual({ id: a.id, duplicate: true, processed: false });
  });
});

describe("pause deps compose with the effects runner", () => {
  it("scheduleEffects accepts reschedule effects", async () => {
    const s = await seedWorkspace(db);
    const { gateway } = testDeps(db, { now: NOW }, fakeAdapter());
    const id = await queued(s, SLOT);
    const r = await reschedulePost(db, s.workspaceId, id, zonedTime("2026-10-24", "10:00", TZ), USER, { now: NOW });
    await scheduleEffects({ gateway }, id, r.effects);
    expect(gateway.jobs.get(`pst_${id}_g1`)?.runAt.toISOString()).toBe("2026-10-24T14:00:00.000Z");
  });
});
