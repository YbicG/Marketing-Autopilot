import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { approveNextDays, approvePosts, editPost, onVariantChanged, uiSessionFromCookie, voidApproval } from "./approvals.ts";
import { handlePublishDue } from "./due.ts";
import { pausePosting, resumePosting } from "./pause.ts";
import { reconcilePosts } from "./reconcile.ts";
import { rehydrate } from "./rehydrate.ts";
import { scheduleEffects } from "./scheduler.ts";
import { staleSweep } from "./stale-sweep.ts";
import { processWebhookEvent } from "./webhooks.ts";
import { queueView } from "./queue-view.ts";
import { markManualPosted, markTikTokDraftDone } from "./manual.ts";
import { rotateBioLinks } from "./links.ts";
import { addPost, fakeAdapter, seedWorkspace, testDeps, type Seeded } from "./test-fixtures.ts";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const SLOT = new Date("2026-10-20T23:30:00Z"); // Tue 7:30 pm New York
const before = (min: number) => new Date(SLOT.getTime() - min * 60_000);
const after = (min: number) => new Date(SLOT.getTime() + min * 60_000);

const session = (s: Seeded) => uiSessionFromCookie({ userId: "user-1", workspaceId: s.workspaceId, originChecked: true, csrfChecked: true });

async function getPost(id: string) {
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, id));
  return p!;
}

async function events(id: string) {
  return (await db.select().from(schema.postEvents).where(eq(schema.postEvents.postId, id))).map((e) => `${e.event}:${e.toState}`);
}

async function setup(opts: Parameters<typeof seedWorkspace>[1] = {}) {
  const s = await seedWorkspace(db, opts);
  const adapter = fakeAdapter();
  const clock = { now: before(24 * 60) };
  const t = testDeps(db, clock, adapter);
  return { s, adapter, clock, ...t };
}

/** Approve a post and apply the jobs to the gateway, as the web route does. */
async function approveAndQueue(ctx: Awaited<ReturnType<typeof setup>>, postId: string) {
  const r = await approvePosts(db, session(ctx.s), [postId], { now: ctx.clock.now });
  for (const e of r.effects) await scheduleEffects({ gateway: ctx.gateway }, e.postId, e.effects);
  return r;
}

describe("approvals", () => {
  it("writes approvals, audit and post_events rows, queues the post and returns its delayed job", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    const r = await approveAndQueue(t, id);
    expect(r.skipped).toEqual([]);
    expect(r.jobs).toEqual([{ jobId: `pst_${id}_g1`, postId: id, generation: 1, runAt: SLOT }]);
    const p = await getPost(id);
    expect(p.state).toBe("queued");
    expect(p.approvalId).toBe(r.approved[0]!.approvalId);
    expect(p.mediaSnapshot).toHaveLength(1);
    const [appr] = await db.select().from(schema.approvals).where(eq(schema.approvals.entityId, id));
    expect(appr).toMatchObject({ entityType: "post", approvedBy: "user-1", voidedAt: null });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.workspaceId, t.s.workspaceId), eq(schema.auditLog.action, "post.approve")));
    expect(audit).toHaveLength(1);
    expect(await events(id)).toEqual(["approve:approved", "enqueue:queued"]);
    expect(t.gateway.jobs.has(`pst_${id}_g1`)).toBe(true);
  });

  it("refuses a TikTok post with no audience chosen (no default privacy)", async () => {
    const t = await setup({ platform: "tiktok" });
    const id = await addPost(db, t.s, SLOT, { platform: "tiktok", platformOptions: { musicConsent: true } });
    const r = await approvePosts(db, session(t.s), [id], { now: t.clock.now });
    expect(r.approved).toEqual([]);
    expect(r.skipped[0]!.postId).toBe(id);
    expect((await getPost(id)).state).toBe("pending_approval");
  });

  it("bulk approves the next 7 days only", async () => {
    const t = await setup();
    const soon = await addPost(db, t.s, SLOT);
    const later = await addPost(db, t.s, new Date(SLOT.getTime() + 10 * 86_400_000));
    const r = await approveNextDays(db, session(t.s), { now: t.clock.now, productId: t.s.productId });
    expect(r.approved.map((a) => a.postId)).toEqual([soon]);
    expect((await getPost(later)).state).toBe("pending_approval");
  });

  it("an options edit voids the approval and removes the delayed job", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    const r = await editPost(db, t.s.workspaceId, id, { platformOptions: { replyControl: "mentioned_only" } }, { type: "user", id: "user-1" }, { now: t.clock.now });
    await scheduleEffects({ gateway: t.gateway }, id, r!.effects);
    const p = await getPost(id);
    expect(p.state).toBe("pending_approval");
    expect(p.approvalId).toBeNull();
    expect(t.gateway.jobs.has(`pst_${id}_g1`)).toBe(false);
    const [appr] = await db.select().from(schema.approvals).where(eq(schema.approvals.entityId, id));
    expect(appr!.voidedAt).not.toBeNull();
  });

  it("a text or media change on the variant sends every approved post of it back for approval", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    // A no-op save keeps the approval.
    expect(await onVariantChanged(db, t.s.workspaceId, t.s.variantId, { type: "user", id: "u" }, { now: t.clock.now })).toEqual([]);
    await db.update(schema.variants).set({ body: { text: "New words {{link:landing}}" } }).where(eq(schema.variants.id, t.s.variantId));
    const r = await onVariantChanged(db, t.s.workspaceId, t.s.variantId, { type: "user", id: "u" }, { now: t.clock.now });
    for (const x of r) await scheduleEffects({ gateway: t.gateway }, x.postId, x.effects);
    expect((await getPost(id)).state).toBe("pending_approval");
    expect(t.gateway.jobs.size).toBe(0);
  });

  it("voidApproval (e.g. a re-render) returns the post to pending_approval", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    const r = await voidApproval(db, t.s.workspaceId, id, "Re-rendered", { type: "worker" }, { now: t.clock.now });
    await scheduleEffects({ gateway: t.gateway }, id, r!.effects);
    expect((await getPost(id)).state).toBe("pending_approval");
    expect(t.gateway.jobs.size).toBe(0);
  });
});

describe("publish.due", () => {
  it("prepares and submits exactly once with the idempotency key, UTM links and a tracked_links row", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("submitted");
    expect(t.adapter.submits).toHaveLength(1);
    const req = t.adapter.submits[0]!;
    expect(req.externalId).toBe(`pst_${id}_g1`);
    const url = new URL(req.text.match(/https:\/\/\S+/)![0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: "threads",
      utm_medium: "organic",
      utm_campaign: `${(await db.select().from(schema.products).where(eq(schema.products.id, t.s.productId)))[0]!.slug}-${t.s.campaignId.replaceAll("-", "").slice(-8)}`,
      utm_content: t.s.variantId,
      utm_term: t.s.angleId,
    });
    const links = await db.select().from(schema.trackedLinks).where(eq(schema.trackedLinks.variantId, t.s.variantId));
    expect(links).toHaveLength(1);
    const p = await getPost(id);
    expect(p).toMatchObject({ state: "submitted", providerRequestId: `req_pst_${id}_g1` });
    expect(await events(id)).toEqual(["approve:approved", "enqueue:queued", "due:preparing", "prepared:submitting", "accepted:submitted"]);
    // A duplicate delivery of the same job does nothing.
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("stale_job");
    expect(t.adapter.submits).toHaveLength(1);
  });

  it("never publishes without an approval row", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT, { state: "queued" });
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect(t.adapter.submits).toHaveLength(0);
  });

  it("a hash mismatch at prepare returns the post to pending_approval and voids the approval", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    await db.update(schema.variants).set({ body: { text: "Sneaky change" } }).where(eq(schema.variants.id, t.s.variantId));
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect(t.adapter.submits).toHaveLength(0);
    const [appr] = await db.select().from(schema.approvals).where(eq(schema.approvals.entityId, id));
    expect(appr!.voidedAt).not.toBeNull();
  });

  it("a replaced media file (different bytes, same asset) is caught at prepare", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    await db.update(schema.assets).set({ sha256: "f".repeat(64) }).where(eq(schema.assets.id, t.s.assetId));
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect(t.adapter.submits).toHaveLength(0);
  });

  it(`a slot missed by more than the grace window becomes missed and never posts late`, async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    t.clock.now = after(180);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("missed");
    expect(t.adapter.submits).toHaveLength(0);
    expect((await getPost(id)).missedAt).toEqual(after(180));
  });

  it("rejects assisted-only venues at prepare", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    await db.update(schema.posts).set({ platform: "reddit" }).where(eq(schema.posts.id, id));
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(t.adapter.submits).toHaveLength(0);
  });

  it("an adapter block from validate() fails the post with the plain reason", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    t.adapter.validateIssues = [{ code: "x", message: "Too many images for Threads.", severity: "block" }];
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("failed");
    expect((await getPost(id)).lastError).toBe("Too many images for Threads.");
  });

  it("a claim that expires before the slot sends the post back at prepare", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    await db.update(schema.claims).set({ expiresAt: before(10) }).where(eq(schema.claims.id, t.s.claimId));
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect((await getPost(id)).staleReason).toMatch(/expires before it posts/);
  });

  it("maps tier B to the platform AI flag and blocks tier C", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT, { platform: "x" });
    await db.update(schema.socialConnections).set({ platform: "x" }).where(eq(schema.socialConnections.id, t.s.connectionId));
    await db.update(schema.assets).set({ provenanceTier: "B" }).where(eq(schema.assets.id, t.s.assetId));
    await approveAndQueue(t, id);
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("submitted");
    expect(t.adapter.submits[0]!.aiFlags).toEqual({ made_with_ai: true });
    // X without the links add-on: the link becomes "link in bio".
    expect(t.adapter.submits[0]!.text).toContain("link in bio");

    const t2 = await setup();
    const id2 = await addPost(db, t2.s, SLOT);
    await db.update(schema.assets).set({ provenanceTier: "C" }).where(eq(schema.assets.id, t2.s.assetId));
    await approveAndQueue(t2, id2);
    t2.clock.now = after(1);
    expect(await handlePublishDue(t2.deps, { postId: id2, generation: 1 })).toBe("failed");
  });

  it("adds a caption label when the route can't carry the AI flag", async () => {
    const t = await setup();
    t.adapter.aiFlags = [];
    const id = await addPost(db, t.s, SLOT, { platform: "x" });
    await db.update(schema.socialConnections).set({ platform: "x" }).where(eq(schema.socialConnections.id, t.s.connectionId));
    await db.update(schema.assets).set({ provenanceTier: "B" }).where(eq(schema.assets.id, t.s.assetId));
    await approveAndQueue(t, id);
    t.clock.now = after(1);
    await handlePublishDue(t.deps, { postId: id, generation: 1 });
    expect(t.adapter.submits[0]!.text).toContain("(Made with AI)");
    expect(t.adapter.submits[0]!.aiFlags).toEqual({});
  });
});

describe("unknown and reconcile", () => {
  it("a timeout leaves the post unknown; it is never re-sent until lookup says absent", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    t.adapter.onSubmit = () => new Promise(() => undefined); // hangs past submitTimeoutMs
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("unknown");
    expect(t.adapter.submits).toHaveLength(1);

    // Lookup fails (network): stays unknown, still no re-send.
    t.adapter.onLookup = () => Promise.reject(new Error("network"));
    t.clock.now = after(5);
    await reconcilePosts(t.deps, { workspaceId: t.s.workspaceId });
    expect((await getPost(id)).state).toBe("unknown");
    // Found: the upload did land.
    t.adapter.onLookup = async () => ({ state: "accepted", requestId: "req-late" });
    t.clock.now = after(60);
    await reconcilePosts(t.deps, { workspaceId: t.s.workspaceId });
    expect(await getPost(id)).toMatchObject({ state: "submitted", providerRequestId: "req-late", generation: 1 });
    expect(t.adapter.submits).toHaveLength(1);

    t.adapter.onStatus = async () => ({ state: "published", url: "https://threads.test/p/1", postId: "tp1" });
    t.clock.now = after(90);
    await reconcilePosts(t.deps, { workspaceId: t.s.workspaceId });
    expect(await getPost(id)).toMatchObject({ state: "published", platformUrl: "https://threads.test/p/1" });
    expect(t.analytics.map((a) => a.postId)).toEqual([id]);
  });

  it("absent → approved with generation+1 and a new job id; after 3 generations it fails (Needs you)", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    t.adapter.onSubmit = async () => ({ state: "failed", reason: "502", retryable: true });
    t.adapter.onLookup = async () => "absent";

    let minute = 1;
    for (let gen = 1; gen <= 3; gen++) {
      t.clock.now = after(minute);
      expect(await handlePublishDue(t.deps, { postId: id, generation: gen })).toBe("unknown");
      expect(t.adapter.submits.map((r) => r.externalId).at(-1)).toBe(`pst_${id}_g${gen}`);
      minute += 2;
      t.clock.now = after(minute);
      await reconcilePosts(t.deps, { workspaceId: t.s.workspaceId });
      const p = await getPost(id);
      if (gen < 3) {
        expect(p).toMatchObject({ state: "queued", generation: gen + 1, idempotencyKey: `pst_${id}_g${gen + 1}` });
        expect(t.gateway.jobs.has(`pst_${id}_g${gen + 1}`)).toBe(true);
      } else {
        expect(p.state).toBe("failed");
        expect(p.lastError).toMatch(/3 times/);
      }
    }
    expect(t.adapter.submits).toHaveLength(3);
  });

  it("webhooks are idempotent: upload_completed publishes once", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    t.clock.now = after(1);
    await handlePublishDue(t.deps, { postId: id, generation: 1 });
    const whId = uuidv7();
    await db.insert(schema.webhookEvents).values({
      id: whId,
      provider: "upload_post",
      eventId: `evt_${whId}`,
      type: "upload_completed",
      body: JSON.stringify({ kind: "upload_completed", eventId: `evt_${whId}`, externalId: `pst_${id}_g1`, url: "https://threads.test/p/9" }),
    });
    expect(await processWebhookEvent(t.deps, whId)).toBe("processed");
    expect(await processWebhookEvent(t.deps, whId)).toBe("duplicate");
    expect(await getPost(id)).toMatchObject({ state: "published", platformUrl: "https://threads.test/p/9" });
    const n = (await events(id)).filter((e) => e === "published:published").length;
    expect(n).toBe(1);

    // The same event under a new row id (provider retry with a new id) is a no-op for a published post.
    const wh2 = uuidv7();
    await db.insert(schema.webhookEvents).values({
      id: wh2,
      provider: "upload_post",
      eventId: `evt_${wh2}`,
      body: JSON.stringify({ kind: "upload_completed", eventId: `evt_${wh2}`, externalId: `pst_${id}_g1` }),
    });
    expect(await processWebhookEvent(t.deps, wh2)).toBe("processed");
    expect((await events(id)).filter((e) => e === "published:published")).toHaveLength(1);
  });

  it("a reauth webhook flags the connection", async () => {
    const t = await setup();
    const whId = uuidv7();
    const [conn] = await db.select().from(schema.socialConnections).where(eq(schema.socialConnections.id, t.s.connectionId));
    await db.insert(schema.webhookEvents).values({
      id: whId,
      provider: "upload_post",
      eventId: `evt_${whId}`,
      body: JSON.stringify({ kind: "reauth_required", eventId: `evt_${whId}`, profileRef: conn!.profileRef, platform: "threads" }),
    });
    expect(await processWebhookEvent(t.deps, whId)).toBe("processed");
    const [after_] = await db.select().from(schema.socialConnections).where(eq(schema.socialConnections.id, t.s.connectionId));
    expect(after_!.status).toBe("reauth_required");
  });
});

describe("pause, stale, rehydrate", () => {
  it("pause removes every job; resume re-queues future slots and marks past ones missed", async () => {
    const t = await setup();
    const a = await addPost(db, t.s, SLOT);
    const b = await addPost(db, t.s, after(60 * 24));
    await approveAndQueue(t, a);
    await approveAndQueue(t, b);
    expect(t.gateway.jobs.size).toBe(2);
    const actor = { type: "user" as const, id: "user-1" };
    expect(await pausePosting(t.deps, { workspaceId: t.s.workspaceId }, actor)).toEqual({ paused: 2 });
    expect(t.gateway.jobs.size).toBe(0);
    expect((await getPost(a)).state).toBe("paused");

    t.clock.now = after(180); // a's slot is 3 h gone, b's is tomorrow
    expect(await resumePosting(t.deps, { workspaceId: t.s.workspaceId }, actor)).toEqual({ queued: 1, missed: 1 });
    expect((await getPost(a)).state).toBe("missed");
    expect((await getPost(b)).state).toBe("queued");
    expect([...t.gateway.jobs.keys()]).toEqual([`pst_${b}_g1`]);
  });

  it("stale.sweep sends back posts whose claim was rejected or whose profile field changed", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    expect((await staleSweep(t.deps, { workspaceId: t.s.workspaceId })).stale).toEqual([]);
    await db.update(schema.claims).set({ status: "rejected" }).where(eq(schema.claims.id, t.s.claimId));
    const r = await staleSweep(t.deps, { workspaceId: t.s.workspaceId });
    expect(r.stale.map((x) => x.postId)).toEqual([id]);
    const p = await getPost(id);
    expect(p.state).toBe("pending_approval");
    expect(p.staleReason).toMatch(/rejected/);
    expect(t.gateway.jobs.size).toBe(0);

    // A new DNA version that changes a field the post used.
    const t2 = await setup();
    const id2 = await addPost(db, t2.s, SLOT);
    await approveAndQueue(t2, id2);
    const v2 = uuidv7();
    await db.insert(schema.productDnaVersions).values({
      id: v2,
      workspaceId: t2.s.workspaceId,
      productId: t2.s.productId,
      version: 2,
      status: "confirmed",
      dna: { offer: { pricing: "$4/month" } },
      fields: {},
      sourceMap: {},
    });
    await db.insert(schema.claims).values({
      id: uuidv7(),
      workspaceId: t2.s.workspaceId,
      productId: t2.s.productId,
      dnaVersionId: v2,
      ref: "C1",
      kind: "feature",
      text: "Turns a syllabus into a calendar",
      sourceRefs: ["S1"],
      publicOk: true,
    });
    await db.update(schema.products).set({ currentDnaVersionId: v2 }).where(eq(schema.products.id, t2.s.productId));
    const r2 = await staleSweep(t2.deps, { productId: t2.s.productId });
    expect(r2.stale[0]!.reason).toMatch(/offer\.pricing/);
  });

  it("boot.rehydrate is idempotent: same jobIds, never duplicated, late slots missed", async () => {
    const t = await setup();
    const queued = await addPost(db, t.s, SLOT);
    const approvedOnly = await addPost(db, t.s, after(60));
    const late = await addPost(db, t.s, before(60 * 5));
    await approveAndQueue(t, queued);
    await approveAndQueue(t, late);
    // approvedOnly: approved but its enqueue never happened (crash between the two).
    const r = await approvePosts(db, session(t.s), [approvedOnly], { now: t.clock.now });
    void r;
    await db.update(schema.posts).set({ state: "approved" }).where(eq(schema.posts.id, approvedOnly));

    // Redis lost everything.
    t.gateway.jobs.clear();
    t.clock.now = before(30); // `late` is now 4.5 h past its slot
    const first = await rehydrate({ db, gateway: t.gateway, graceMin: 120, now: () => t.clock.now, workspaceId: t.s.workspaceId });
    const keys1 = [...t.gateway.jobs.keys()].sort();
    const second = await rehydrate({ db, gateway: t.gateway, graceMin: 120, now: () => t.clock.now, workspaceId: t.s.workspaceId });
    const keys2 = [...t.gateway.jobs.keys()].sort();

    expect(keys1).toEqual([`pst_${approvedOnly}_g1`, `pst_${queued}_g1`].sort());
    expect(keys2).toEqual(keys1);
    expect(first).toMatchObject({ created: 2, missed: 1 });
    expect(second).toMatchObject({ created: 0, missed: 0 });
    expect(t.gateway.log.filter((l) => l.startsWith("ensure:"))).toHaveLength(2);
    expect((await getPost(late)).state).toBe("missed");
    expect((await getPost(approvedOnly)).state).toBe("queued");
  });

  it("rehydrate turns an interrupted submit into unknown, never a re-send", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    await db.update(schema.posts).set({ state: "submitting", updatedAt: before(30) }).where(eq(schema.posts.id, id));
    t.clock.now = after(5);
    const r = await rehydrate({ db, gateway: t.gateway, graceMin: 120, now: () => t.clock.now, workspaceId: t.s.workspaceId });
    expect(r.unknown).toBe(1);
    expect((await getPost(id)).state).toBe("unknown");
    expect(t.adapter.submits).toHaveLength(0);
  });
});

describe("caps", () => {
  it("a shared account's daily cap spans products", async () => {
    const ws = uuidv7();
    await db.insert(schema.workspaces).values({ id: ws, name: "caps", timezone: "America/New_York" });
    const a = await seedWorkspace(db, { workspaceId: ws, platform: "x", shared: true, handle: "cj" });
    const b = await seedWorkspace(db, { workspaceId: ws, platform: "x", shared: true, handle: "@CJ" });
    const adapter = fakeAdapter();
    const clock = { now: before(60) };
    const { deps, gateway } = testDeps(db, clock, adapter);
    // Two posts from product A already went out today on its connection to @cj.
    await addPost(db, a, before(600), { platform: "x", state: "published" });
    await addPost(db, a, before(300), { platform: "x", state: "published" });
    const id = await addPost(db, b, SLOT, { platform: "x" });
    const r = await approvePosts(db, uiSessionFromCookie({ userId: "u", workspaceId: ws, originChecked: true, csrfChecked: true }), [id], { now: clock.now });
    for (const e of r.effects) await scheduleEffects({ gateway }, e.postId, e.effects);
    clock.now = after(1);
    expect(await handlePublishDue(deps, { postId: id, generation: 1 })).toBe("failed");
    expect((await getPost(id)).lastError).toMatch(/@cj already has 2 posts that day across your products/i);
    expect(adapter.submits).toHaveLength(0);

    // The Queue screen flags the same conflict ahead of time.
    const view = await queueView(db, ws, { from: before(24 * 60), to: after(24 * 60), now: before(60) });
    expect(view.needsYou.some((n) => n.kind === "failed" && n.postId === id)).toBe(true);
  });

  it("2 per platform per day per product, and the status line names the next slot", async () => {
    const t = await setup();
    await addPost(db, t.s, before(120), { state: "published" });
    await addPost(db, t.s, before(60), { state: "published" });
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    const view = await queueView(db, t.s.workspaceId, { from: before(24 * 60), to: after(24 * 60), now: before(30) });
    const flagged = view.days.flatMap((d) => d.posts).find((p) => p.id === id)!;
    expect(flagged.conflicts.join(" ")).toMatch(/Already 2 threads posts/);
    expect(view.statusLine).toBe("Next post Tue 7:30 pm");
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("failed");
  });

  it("warm-up: a new account posts once a day", async () => {
    const t = await setup();
    await db.update(schema.socialConnections).set({ warmupUntil: after(7 * 24 * 60) }).where(eq(schema.socialConnections.id, t.s.connectionId));
    await addPost(db, t.s, before(120), { state: "published" });
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("failed");
    expect((await getPost(id)).lastError).toMatch(/once a day/);
  });
});

describe("manual", () => {
  it("Download & post yourself marks the post published with the pasted URL and drops its job", async () => {
    const t = await setup();
    const id = await addPost(db, t.s, SLOT);
    await approveAndQueue(t, id);
    await markManualPosted(t.deps, t.s.workspaceId, id, "https://threads.net/@me/post/1", { type: "user", id: "user-1" });
    expect(await getPost(id)).toMatchObject({ state: "published", platformUrl: "https://threads.net/@me/post/1" });
    expect(t.gateway.jobs.size).toBe(0);
  });
});

describe("TikTok drafts mode and bio links", () => {
  it("drafts mode ends in awaiting_user (needs manual finish) until the person marks it done", async () => {
    const t = await setup({ platform: "tiktok" });
    const id = await addPost(db, t.s, SLOT, {
      platform: "tiktok",
      platformOptions: { privacyLevel: "PUBLIC_TO_EVERYONE", musicConsent: true, postMode: "drafts" },
    });
    await approveAndQueue(t, id);
    t.clock.now = after(1);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("awaiting_user");
    expect(t.adapter.submits[0]!.options).toMatchObject({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: true, postMode: "drafts" });
    // TikTok captions can't link: the token became "link in bio".
    expect(t.adapter.submits[0]!.text).toContain("link in bio");
    const view = await queueView(db, t.s.workspaceId, { from: before(60), to: after(60) });
    expect(view.needsYou.map((n) => n.kind)).toContain("finish_in_app");
    await markTikTokDraftDone(t.deps, t.s.workspaceId, id, "https://www.tiktok.com/@me/video/1", { type: "user", id: "user-1" });
    expect((await getPost(id)).state).toBe("published");
  });

  it("rotates one bio link per account per week to the lead angle, idempotently", async () => {
    const t = await setup();
    const a = await rotateBioLinks(db, t.s.workspaceId, { now: SLOT, tz: "America/New_York" });
    const b = await rotateBioLinks(db, t.s.workspaceId, { now: SLOT, tz: "America/New_York" });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ week: "2026-W43", created: true });
    expect(b[0]).toMatchObject({ created: false, url: a[0]!.url });
    const url = new URL(a[0]!.url);
    expect(url.searchParams.get("utm_content")).toBe(t.s.angleId);
    expect(url.searchParams.get("utm_source")).toBe("threads");
  });
});
