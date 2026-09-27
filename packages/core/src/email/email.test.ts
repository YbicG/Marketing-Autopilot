import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { createResend, fakeResend, type FakeResend, type ProviderCtx, type ResendWebhookEvent } from "@mkt/providers";
import { fakeClient, jsonReply } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { uiSessionFromCookie, type UiSession } from "../publishing/approvals.ts";
import { storeWebhookEvent } from "../publishing/screens.ts";
import { broadcastContext, hashRow } from "./context.ts";
import { createBroadcastDraft, executeEmailDraft } from "./generate.ts";
import { hashEmail } from "./hash.ts";
import { cancelBroadcastAtResend, processResendWebhook, resendWorkspaceHint, submitBroadcast, toStoredResendEvent, type EmailJobDeps } from "./jobs.ts";
import { loadBroadcast } from "./store.ts";
import { broadcastStats, isSuppressed, recordSuppression } from "./suppression.ts";
import { approveBroadcast, broadcastView, cancelBroadcast, listBroadcasts, pauseBroadcasts, saveBroadcast, saveEmailSettings } from "./ui.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
let ws: string;
let productId: string;
let planId: string;
let session: UiSession;
const USER = "user_cj";
const NOW = new Date("2026-12-20T12:00:00Z");
const SEND_AT = "2027-01-06T15:00:00.000Z";

const settings = {
  fromName: "CJ at SyllaCal",
  fromEmail: "cj@syllacal.com",
  replyTo: "help@syllacal.com",
  postalAddress: "PO Box 123, Austin, TX 78701",
  audienceId: "seg_buyers",
  audienceLabel: "Past buyers",
  consentSource: "you bought SyllaCal and said yes to product news",
  euConsentAck: true,
};

const goodDraft = {
  subject: "Your spring semester, sorted",
  preheader: "What's new in SyllaCal before classes start",
  paragraphs: ["Thanks for using SyllaCal last term.", "Drop in your new syllabi and your deadlines land in your calendar.", "Get set up: {{link:landing}}"],
  claimRefs: ["C1"],
};

const ctxFor = (): ProviderCtx => ({ secret: async (p) => (p === "resend.api_key" ? "re_test_key" : null) });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
  ws = uuidv7();
  productId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t", timezone: "America/New_York" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal", urls: { website: "https://syllacal.com/" }, emailSettings: settings });
  const dnaId = uuidv7();
  await db.insert(schema.productDnaVersions).values({ id: dnaId, workspaceId: ws, productId, version: 1, status: "confirmed", dna: {}, fields: {}, sourceMap: {} });
  await db.update(schema.products).set({ currentDnaVersionId: dnaId }).where(eq(schema.products.id, productId));
  await db.insert(schema.claims).values([
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C1", kind: "feature", text: "Turns a syllabus into calendar events", sourceRefs: ["S1"], publicOk: true },
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C2", kind: "stat", text: "Internal number", sourceRefs: ["S1"], publicOk: false },
  ]);
  const strategyId = uuidv7();
  await db.insert(schema.strategies).values({ id: strategyId, workspaceId: ws, productId, dnaVersionId: dnaId, output: {} });
  await db.insert(schema.campaignBundles).values({ id: uuidv7(), workspaceId: ws, productId, strategyId, dnaVersionId: dnaId, version: 1, text: "<campaign_bundle>SyllaCal</campaign_bundle>", claimRefs: ["C1"] });
  planId = uuidv7();
  await db.insert(schema.launchPlans).values({ id: planId, workspaceId: ws, productId, startDate: "2027-01-06", launchDate: "2027-01-19", templateVersion: "t1" });
  session = uiSessionFromCookie({ userId: USER, workspaceId: ws, originChecked: true, csrfChecked: true });
});
afterAll(() => close());

/** A broadcast written by copy.email and waiting for approval. */
async function pending(opts: { draft?: typeof goodDraft; scheduledAt?: string } = {}): Promise<string> {
  const c = await createBroadcastDraft(db, ws, { productId, launchPlanId: planId, name: "January", userId: USER, scheduledAt: new Date(opts.scheduledAt ?? SEND_AT) });
  if (!c.ok) throw new Error(c.reason);
  const d = opts.draft ?? goodDraft;
  const { client } = fakeClient([jsonReply(d), jsonReply(d)]);
  const r = await executeEmailDraft({ db, rates, client, now: () => NOW }, c.job.data);
  expect(r.ok).toBe(true);
  return c.broadcastId;
}

function jobDeps(fake: FakeResend): EmailJobDeps {
  return { db, provider: createResend({ fetch: fake.fetch, sleep: async () => {} }), ctxFor, now: () => NOW };
}

async function approved(fake: FakeResend): Promise<string> {
  const id = await pending();
  const a = await approveBroadcast(db, session, id, { now: NOW });
  if (!a.ok) throw new Error(a.reason);
  fake.addContacts("seg_buyers", []);
  return id;
}

async function webhook(e: Partial<ResendWebhookEvent> & { type: ResendWebhookEvent["type"] }) {
  const full: ResendWebhookEvent = {
    eventId: `msg_${uuidv7()}`,
    rawType: e.type,
    createdAt: NOW.toISOString(),
    broadcastId: null,
    emailId: "em_1",
    to: [],
    bounceType: null,
    contactId: null,
    contactEmail: null,
    unsubscribed: null,
    audienceIds: [],
    ...e,
  };
  const stored = await storeWebhookEvent(db, { provider: "resend", eventId: full.eventId, type: full.type, body: JSON.stringify(toStoredResendEvent(full)), workspaceId: null });
  return stored.id;
}

describe("drafting (copy.email)", () => {
  it("creates the run and broadcast, writes it, and sends it for approval", async () => {
    const c = await createBroadcastDraft(db, ws, { productId, launchPlanId: planId, name: "January", userId: USER });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.job).toEqual({ queue: "generate", name: "email.draft", data: { runId: c.runId, broadcastId: c.broadcastId }, jobId: `run:${c.runId}` });
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, c.runId));
    expect(run).toMatchObject({ kind: "broadcast", status: "queued" });
    const before = await loadBroadcast(db, ws, c.broadcastId);
    // Default send time: launch day 10:00 workspace time (EST in January).
    expect(before!.scheduledAt!.toISOString()).toBe("2027-01-19T15:00:00.000Z");
    expect(before).toMatchObject({ status: "draft", audienceId: "seg_buyers" });

    const { client, calls } = fakeClient([jsonReply(goodDraft)]);
    await executeEmailDraft({ db, rates, client, now: () => NOW }, c.job.data);
    const row = await loadBroadcast(db, ws, c.broadcastId);
    expect(row).toMatchObject({ status: "pending_approval", subject: goodDraft.subject, claimIds: ["C1"], lastError: null });
    expect(row!.body).toBe(goodDraft.paragraphs.join("\n\n"));
    expect(row!.issues).toEqual([]);
    expect(calls).toHaveLength(1);
    const sys = String(calls[0]!.system ?? JSON.stringify(calls[0]));
    expect(sys).toMatch(/past buyers/);
    expect(sys).toMatch(/Never invent testimonials/);
    const [done] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, c.runId));
    expect(done!.status).toBe("completed");
    // Running the same job again does nothing.
    expect((await executeEmailDraft({ db, rates, client, now: () => NOW }, c.job.data)).ok).toBe(false);
  });

  it("repairs once, then leaves what's still wrong for the user", async () => {
    const c = await createBroadcastDraft(db, ws, { productId, name: "Repair", userId: USER, scheduledAt: new Date(SEND_AT) });
    if (!c.ok) throw new Error(c.reason);
    const bad = { ...goodDraft, subject: "Re: URGENT: 5 new features", claimRefs: [] };
    const { client, calls } = fakeClient([jsonReply(bad), jsonReply({ ...bad, paragraphs: ["See https://syllacal.com now"] })]);
    await executeEmailDraft({ db, rates, client, now: () => NOW }, c.job.data);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toMatch(/failed these checks/);
    const row = await loadBroadcast(db, ws, c.broadcastId);
    expect(row!.status).toBe("pending_approval");
    expect(row!.lastError).toMatch(/^Needs you:/);
    // Hand-typed addresses are stripped as a last resort.
    expect(row!.body).not.toMatch(/https?:/);
    expect(row!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["subject_fake_reply", "subject_urgency", "subject_number_without_source"]));
  });
});

describe("approval (D9)", () => {
  it("needs a UI session", async () => {
    const id = await pending();
    await expect(approveBroadcast(db, {} as UiSession, id)).rejects.toThrow(/UI session/);
    const other = uiSessionFromCookie({ userId: USER, workspaceId: uuidv7(), originChecked: true, csrfChecked: true });
    expect(await approveBroadcast(db, other, id, { now: NOW })).toMatchObject({ ok: false, reason: "Broadcast not found." });
  });

  it("renders, checks, writes the approval with the content hash and an audit row, and submits", async () => {
    const id = await pending();
    const a = await approveBroadcast(db, session, id, { now: NOW });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.effects).toEqual([{ type: "submit", broadcastId: id, jobId: `bc-${id}-1` }]);
    const row = (await loadBroadcast(db, ws, id))!;
    expect(row.status).toBe("approved");
    expect(row.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
    expect(row.text).toContain("PO Box 123");
    const [appr] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, a.approvalId));
    const ctx = (await broadcastContext(db, row))!;
    expect(appr).toMatchObject({ entityType: "broadcast", entityId: id, approvedBy: USER, contentHash: hashRow(row, ctx.settings) });
    expect(row.contentHash).toBe(appr!.contentHash);
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entity, `broadcast:${id}`), eq(schema.auditLog.action, "broadcast.approve")));
    expect(audits).toHaveLength(1);
    // Can't approve twice.
    expect((await approveBroadcast(db, session, id, { now: NOW })).ok).toBe(false);
  });

  it("refuses while a law check blocks", async () => {
    const id = await pending({ draft: { ...goodDraft, claimRefs: ["C2"] } });
    const a = await approveBroadcast(db, session, id, { now: NOW });
    expect(a).toMatchObject({ ok: false, reason: expect.stringMatching(/private fact/) });
    expect((await loadBroadcast(db, ws, id))!.status).toBe("pending_approval");
  });
});

describe("email.submit at Resend", () => {
  let fake: FakeResend;
  beforeEach(() => {
    fake = fakeResend();
  });

  it("checks suppressions, creates, stores the id, schedules; a second run doesn't create again", async () => {
    await recordSuppression(db, ws, " B@Example.com ", "unsubscribed", "manual");
    fake.addContacts("seg_buyers", ["a@example.com", "b@example.com", "c@example.com"]);
    fake.contacts[2]!.unsubscribed = true;
    const id = await approved(fake);
    const deps = jobDeps(fake);

    expect(await submitBroadcast(deps, id)).toBe("scheduled");
    const row = (await loadBroadcast(db, ws, id))!;
    expect(row.status).toBe("scheduled_at_resend");
    const rb = fake.broadcasts.get(row.resendBroadcastId!)!;
    expect(rb).toMatchObject({ status: "scheduled", scheduledAt: SEND_AT, segmentId: "seg_buyers", from: "CJ at SyllaCal <cj@syllacal.com>", replyTo: "help@syllacal.com", subject: goodDraft.subject });
    expect(rb.name).toContain(row.approvalId!);
    expect(rb.html).toBe(row.html);
    // Suppressed b@ was unsubscribed at Resend before the broadcast was created; c@ was learned.
    const order = fake.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(order.indexOf("PATCH /contacts/ct_2")).toBeLessThan(order.indexOf("POST /broadcasts"));
    expect(fake.contacts[1]!.unsubscribed).toBe(true);
    expect(fake.contacts[0]!.unsubscribed).toBe(false);
    expect(await isSuppressed(db, ws, "c@example.com")).toBe(true);

    // Same job again (e.g. a duplicate delivery): nothing new at Resend.
    expect(await submitBroadcast(deps, id)).toBe("skipped");
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/broadcasts")).toHaveLength(1);
  });

  it("after a crash between create and scheduled, it reconciles instead of creating twice", async () => {
    const id = await approved(fake);
    const deps = jobDeps(fake);
    let failSend = true;
    fake.intercept = (m, p) => (m === "POST" && p.endsWith("/send") && failSend ? new Response("{}", { status: 500 }) : undefined);
    expect(await submitBroadcast(deps, id)).toBe("failed");
    let row = (await loadBroadcast(db, ws, id))!;
    expect(row.status).toBe("failed");
    const firstId = row.resendBroadcastId!;
    expect(firstId).toBeTruthy();

    // Simulate the other crash window: Resend scheduled it but we never recorded it.
    failSend = false;
    fake.broadcasts.get(firstId)!.status = "scheduled";
    await db.update(schema.emailBroadcasts).set({ status: "approved", lastError: null }).where(eq(schema.emailBroadcasts.id, id));
    expect(await submitBroadcast(deps, id)).toBe("reconciled");
    row = (await loadBroadcast(db, ws, id))!;
    expect(row).toMatchObject({ status: "scheduled_at_resend", resendBroadcastId: firstId });
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/broadcasts")).toHaveLength(1);
  });

  it("a send that errored but was actually scheduled counts as scheduled", async () => {
    const id = await approved(fake);
    fake.intercept = (m, p) => {
      if (m === "POST" && p.endsWith("/send")) {
        const b = [...fake.broadcasts.values()][0]!;
        b.status = "scheduled";
        return new Response("{}", { status: 502 });
      }
      return undefined;
    };
    expect(await submitBroadcast(jobDeps(fake), id)).toBe("scheduled");
  });

  it("anything changed since approval is not sent", async () => {
    const id = await approved(fake);
    await db.update(schema.emailBroadcasts).set({ html: "<p>swapped</p>" }).where(eq(schema.emailBroadcasts.id, id));
    expect(await submitBroadcast(jobDeps(fake), id)).toBe("changed");
    const row = (await loadBroadcast(db, ws, id))!;
    expect(row.status).toBe("pending_approval");
    expect(row.lastError).toMatch(/changed after you approved/);
    expect(fake.broadcasts.size).toBe(0);
  });

  it("an edit after it's scheduled cancels it at Resend and needs a new approval", async () => {
    const id = await approved(fake);
    const deps = jobDeps(fake);
    await submitBroadcast(deps, id);
    const firstResend = (await loadBroadcast(db, ws, id))!.resendBroadcastId!;
    const approvalId = (await loadBroadcast(db, ws, id))!.approvalId!;

    const s = await saveBroadcast(db, ws, id, { subject: "Your spring semester, sorted (updated)" }, USER, { now: NOW });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.effects).toEqual([{ type: "cancel", broadcastId: id, jobId: `bcx-${id}-1`, reason: "Edited after it was scheduled" }]);
    expect(s.view).toMatchObject({ status: "pending_approval", canApprove: true, scheduledAtResend: false });
    const [appr] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    expect(appr!.voidedAt).not.toBeNull();

    expect(await cancelBroadcastAtResend(deps, { broadcastId: id, reason: "Edited" })).toBe("canceled");
    expect(fake.broadcasts.has(firstResend)).toBe(false);
    expect((await loadBroadcast(db, ws, id))!.resendBroadcastId).toBeNull();

    // Approve again → a new Resend broadcast for the new approval.
    const a = await approveBroadcast(db, session, id, { now: NOW });
    expect(a.ok && a.effects[0]).toMatchObject({ type: "submit", jobId: `bc-${id}-2` });
    expect(await submitBroadcast(deps, id)).toBe("scheduled");
    const row = (await loadBroadcast(db, ws, id))!;
    expect(row.resendBroadcastId).not.toBe(firstResend);
    expect(fake.broadcasts.get(row.resendBroadcastId!)!.subject).toBe("Your spring semester, sorted (updated)");
  });

  it("a late cancel leaves the current approval's broadcast alone, and records one that already went out", async () => {
    const id = await approved(fake);
    const deps = jobDeps(fake);
    await submitBroadcast(deps, id);
    expect(await cancelBroadcastAtResend(deps, { broadcastId: id, reason: "late" })).toBe("current");

    const c = await cancelBroadcast(db, ws, id, { type: "user", id: USER }, { now: NOW });
    expect(c.ok && c.effects.map((e) => e.type)).toEqual(["cancel"]);
    const row = (await loadBroadcast(db, ws, id))!;
    fake.broadcasts.get(row.resendBroadcastId!)!.status = "sent";
    expect(await cancelBroadcastAtResend(deps, { broadcastId: id, reason: "Canceled" })).toBe("already_sent");
    expect((await loadBroadcast(db, ws, id))!).toMatchObject({ status: "sent", lastError: expect.stringMatching(/already gone out/) });
  });

  it("pause cancels scheduled broadcasts", async () => {
    const id = await approved(fake);
    await submitBroadcast(jobDeps(fake), id);
    const r = await pauseBroadcasts(db, ws, productId, { type: "user", id: USER }, { now: NOW });
    expect(r.paused).toBeGreaterThanOrEqual(1);
    expect(r.effects).toContainEqual({ type: "cancel", broadcastId: id, jobId: `bcx-${id}-1`, reason: "Posting was paused" });
    expect((await loadBroadcast(db, ws, id))!.status).toBe("pending_approval");
  });

  it("changing the sender sends approved broadcasts back for approval", async () => {
    const id = await approved(fake);
    const r = await saveEmailSettings(db, ws, productId, { ...settings, fromName: "CJ" }, { type: "user", id: USER }, { now: NOW });
    expect(r.ok).toBe(true);
    expect((await loadBroadcast(db, ws, id))!.status).toBe("pending_approval");
    await saveEmailSettings(db, ws, productId, settings, { type: "user", id: USER });
    expect((await saveEmailSettings(db, ws, productId, { ...settings, fromEmail: "nope" }, { type: "user", id: USER })).ok).toBe(false);
  });
});

describe("Resend webhooks", () => {
  it("counts, marks sent, suppresses bounces/complaints/unsubscribes, and blocks the next send over 0.3% spam", async () => {
    const fake = fakeResend();
    const deps = jobDeps(fake);
    const id = await approved(fake);
    await submitBroadcast(deps, id);
    const rid = (await loadBroadcast(db, ws, id))!.resendBroadcastId!;

    expect(await resendWorkspaceHint(db, JSON.stringify({ type: "email.sent", data: { broadcast_id: rid } }))).toBe(ws);
    expect(await resendWorkspaceHint(db, JSON.stringify({ type: "contact.updated", data: { segment_ids: ["seg_buyers"] } }))).toBe(ws);
    expect(await resendWorkspaceHint(db, "not json")).toBeNull();

    const sent = await webhook({ type: "email.sent", broadcastId: rid, to: ["a@example.com"] });
    expect(await processResendWebhook(deps, sent)).toBe("processed");
    expect(await processResendWebhook(deps, sent)).toBe("duplicate");
    expect((await loadBroadcast(db, ws, id))!).toMatchObject({ status: "sent", sentAt: NOW });

    for (let i = 0; i < 100; i++) await processResendWebhook(deps, await webhook({ type: "email.delivered", broadcastId: rid, to: [`u${i}@example.com`] }));
    await processResendWebhook(deps, await webhook({ type: "email.bounced", broadcastId: rid, to: ["hard@example.com"], bounceType: "Permanent" }));
    await processResendWebhook(deps, await webhook({ type: "email.bounced", broadcastId: rid, to: ["soft@example.com"], bounceType: "Temporary" }));
    await processResendWebhook(deps, await webhook({ type: "email.complained", broadcastId: rid, to: ["angry@example.com"] }));
    await processResendWebhook(deps, await webhook({ type: "contact.unsubscribed", rawType: "contact.updated", contactEmail: "gone@example.com", unsubscribed: true, audienceIds: ["seg_buyers"] }));

    expect(await isSuppressed(db, ws, "hard@example.com")).toBe(true);
    expect(await isSuppressed(db, ws, "soft@example.com")).toBe(false);
    expect(await isSuppressed(db, ws, "Angry@example.com")).toBe(true);
    expect(await isSuppressed(db, ws, "gone@example.com")).toBe(true);
    // Only hashes are stored: no address anywhere in the webhook rows or suppressions.
    const rows = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.provider, "resend"));
    expect(rows.some((r) => r.body.includes("@example.com"))).toBe(false);
    expect(rows.some((r) => r.body.includes(hashEmail("hard@example.com")))).toBe(true);

    expect(await broadcastStats(db, rid)).toMatchObject({ sent: 1, delivered: 100, bounced: 2, complained: 1 });
    const view = await broadcastView(db, ws, id);
    expect(view!.stats).toMatchObject({ delivered: 100, complained: 1 });
    expect((await listBroadcasts(db, ws, productId)).some((b) => b.id === id && b.statusLabel === "Sent")).toBe(true);

    // 1 complaint per 100 delivered = 1% > 0.3%: the next broadcast is blocked.
    const next = await pending();
    const a = await approveBroadcast(db, session, next, { now: NOW });
    expect(a.ok).toBe(false);
    expect(!a.ok && a.issues?.map((i) => i.code)).toContain("spam_rate");
  });
});
