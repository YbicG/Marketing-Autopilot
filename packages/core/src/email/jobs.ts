import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { isTimeout, type ProviderCtx, type ResendBroadcast, type ResendProvider, type ResendWebhookEvent } from "@mkt/providers";
import type { Actor } from "../publishing/store.ts";
import { broadcastContext, hashRow } from "./context.ts";
import { hashEmail } from "./hash.ts";
import { fromHeader, replyToHeader } from "./render.ts";
import type { BroadcastEvent } from "./state-machine.ts";
import { applyBroadcastEvent, applyEmailEffects, BroadcastConflict, type BroadcastRow, type EmailEnqueue } from "./store.ts";
import { enforceSuppressions, recordSuppressionHash, type SuppressionReason } from "./suppression.ts";

const { approvals, auditLog, emailBroadcasts, products, webhookEvents } = schema;
const WORKER: Actor = { type: "worker" };
const WEBHOOK: Actor = { type: "webhook" };

/** The worker's deps for email.submit / email.cancel / email.webhook (publish queue). */
export interface EmailJobDeps {
  db: Db;
  provider: ResendProvider;
  /** Secrets per workspace, vault first then env (resolveSecret with RESEND_API_KEY). */
  ctxFor: (workspaceId: string) => ProviderCtx;
  /** Follow-up effects (e.g. a cancel after a hash mismatch) go back on the publish queue. */
  enqueue?: EmailEnqueue;
  now?: () => Date;
}

/** Resend broadcasts are named "<name> [<approval id>]", so a job can tell whose broadcast it is. */
export function resendName(name: string, approvalId: string): string {
  return `${name.slice(0, 80)} [${approvalId}]`;
}

export function approvalOfResendName(name: string | null): string | null {
  const m = name ? /\[([0-9a-f-]{36})\]\s*$/i.exec(name) : null;
  return m ? m[1]!.toLowerCase() : null;
}

/** Resend has taken it: it will go out (or has) without anything more from us. */
const TAKEN = new Set(["scheduled", "queued", "sending"]);

async function byId(db: Db, id: string): Promise<BroadcastRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(emailBroadcasts).where(eq(emailBroadcasts.id, id));
  return row ?? null;
}

async function event(deps: EmailJobDeps, id: string, e: BroadcastEvent, actor: Actor, opts: { set?: Partial<typeof emailBroadcasts.$inferInsert>; data?: Record<string, unknown> } = {}) {
  const now = (deps.now ?? (() => new Date()))();
  try {
    const r = await deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(emailBroadcasts).where(eq(emailBroadcasts.id, id));
      if (!row) return null;
      return applyBroadcastEvent(tx, row, e, actor, { now, ...opts });
    });
    if (r?.effects.length && deps.enqueue) await applyEmailEffects(deps.enqueue, r.effects);
    return r;
  } catch (err) {
    if (err instanceof BroadcastConflict) return null;
    throw err;
  }
}

async function note(db: Db, row: BroadcastRow, action: string, data: Record<string, unknown>) {
  await db.insert(auditLog).values({ id: uuidv7(), workspaceId: row.workspaceId, actorType: "worker", action, entity: `broadcast:${row.id}`, data });
}

const msg = (err: unknown) => (isTimeout(err) ? "Resend took too long to answer." : err instanceof Error ? err.message : "Something went wrong at Resend.");

export type SubmitOutcome = "missing" | "skipped" | "changed" | "scheduled" | "reconciled" | "sent" | "superseded" | "failed";

/**
 * email.submit (publish queue, single attempt). At most once per approval:
 * 1. Only an approved broadcast whose current hash equals approvals.content_hash goes out.
 * 2. If a Resend broadcast is already recorded, it's reconciled with getBroadcast instead of
 *    created again (a broadcast left from an earlier approval is deleted first).
 * 3. The suppression list is pushed to Resend before anything is created or sent.
 * 4. create → store the id at once → send with scheduled_at → scheduled_at_resend.
 * If the broadcast was edited while we worked, what we made at Resend is deleted again.
 */
export async function submitBroadcast(deps: EmailJobDeps, broadcastId: string): Promise<SubmitOutcome> {
  const { db, provider } = deps;
  const now = (deps.now ?? (() => new Date()))();
  let row = await byId(db, broadcastId);
  if (!row) return "missing";
  if (row.status !== "approved" || !row.approvalId) return "skipped";
  const approvalId = row.approvalId;
  const ctx = await broadcastContext(db, row);
  const [appr] = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, row.workspaceId)));
  const hash = ctx ? hashRow(row, ctx.settings) : null;
  if (!ctx || !appr || appr.voidedAt || appr.entityType !== "broadcast" || appr.entityId !== row.id || !hash || hash !== appr.contentHash) {
    await event(deps, row.id, { type: "void_approval", reason: "Changed since you approved it" }, WORKER, { set: { lastError: "It changed after you approved it. Check it and approve again." } });
    return "changed";
  }
  const pctx = deps.ctxFor(row.workspaceId);
  const fail = async (reason: string) => {
    await event(deps, row!.id, { type: "submit_failed", reason }, WORKER);
    return "failed" as const;
  };
  const markScheduled = async (resendId: string) => {
    const r = await event(deps, row!.id, { type: "scheduled", resendBroadcastId: resendId }, WORKER, { data: { resendBroadcastId: resendId } });
    if (!r) {
      // Edited, paused or canceled while we were talking to Resend: take it back there.
      await provider.deleteBroadcast(pctx, resendId).catch(() => null);
      return "superseded" as const;
    }
    return "scheduled" as const;
  };

  let resendId = row.resendBroadcastId;
  if (resendId) {
    let rb: ResendBroadcast | null;
    try {
      rb = await provider.getBroadcast(pctx, resendId);
    } catch (err) {
      return fail(`Couldn't check the broadcast at Resend: ${msg(err)} Try again.`);
    }
    if (rb && approvalOfResendName(rb.name) === approvalId) {
      if (TAKEN.has(rb.status)) {
        const r = await markScheduled(rb.id);
        return r === "scheduled" ? "reconciled" : r;
      }
      if (rb.status === "sent") {
        await event(deps, row.id, { type: "sent", at: rb.sentAt ? new Date(rb.sentAt) : now }, WORKER);
        return "sent";
      }
      if (rb.status === "canceled") return fail("It was canceled in Resend. Approve it again to send.");
      // Still a draft at Resend: fall through to the suppression check and send it.
    } else {
      if (rb) {
        const del = await provider.deleteBroadcast(pctx, rb.id).catch(() => null);
        await note(db, row, "broadcast.stale_resend_removed", { resendBroadcastId: rb.id, deleted: del?.deleted ?? false });
      }
      await db.update(emailBroadcasts).set({ resendBroadcastId: null }).where(and(eq(emailBroadcasts.id, row.id), eq(emailBroadcasts.resendBroadcastId, resendId)));
      resendId = null;
    }
  }

  try {
    const r = await enforceSuppressions(provider, pctx, row.audienceId!, db, row.workspaceId);
    if (r.unsubscribed || r.learned) await note(db, row, "broadcast.suppressions_enforced", { ...r });
  } catch (err) {
    return fail(`Couldn't check your unsubscribe list at Resend before sending: ${msg(err)} Try again.`);
  }

  if (!resendId) {
    let created: { id: string };
    try {
      created = await provider.createBroadcast(pctx, {
        audienceId: row.audienceId!,
        from: fromHeader(ctx.settings!),
        replyTo: replyToHeader(ctx.settings!),
        subject: row.subject,
        html: row.html!,
        text: row.text!,
        name: resendName(row.name, approvalId),
      });
    } catch (err) {
      return fail(`Resend didn't take the broadcast: ${msg(err)}`);
    }
    // Store the id before anything else, so a crash from here on reconciles instead of re-creating.
    const stored = await db
      .update(emailBroadcasts)
      .set({ resendBroadcastId: created.id, updatedAt: now })
      .where(and(eq(emailBroadcasts.id, row.id), eq(emailBroadcasts.status, "approved"), eq(emailBroadcasts.approvalId, approvalId)))
      .returning();
    if (!stored.length) {
      await provider.deleteBroadcast(pctx, created.id).catch(() => null);
      return "superseded";
    }
    row = stored[0]!;
    resendId = created.id;
  }

  const at = new Date(Math.max(row.scheduledAt!.getTime(), now.getTime() + 60_000));
  try {
    await provider.sendBroadcast(pctx, resendId, { scheduledAt: at });
  } catch (err) {
    // An answer lost in transit may still have scheduled it: look before calling it failed.
    const rb = await provider.getBroadcast(pctx, resendId).catch(() => null);
    if (!rb || !TAKEN.has(rb.status)) return fail(`Resend didn't schedule it: ${msg(err)}`);
  }
  return markScheduled(resendId);
}

export type CancelOutcome = "missing" | "nothing_at_resend" | "current" | "canceled" | "already_sent" | "not_deletable";

/**
 * email.cancel: delete the broadcast at Resend (Resend allows it only while draft or scheduled;
 * deleting a scheduled one cancels delivery). If it has already gone out, that's recorded plainly.
 * A broadcast that belongs to the current approval (re-approved since the cancel was queued) is left alone.
 */
export async function cancelBroadcastAtResend(deps: EmailJobDeps, data: { broadcastId: string; reason: string }): Promise<CancelOutcome> {
  const { db, provider } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const row = await byId(db, data.broadcastId);
  if (!row) return "missing";
  const resendId = row.resendBroadcastId;
  if (!resendId) return "nothing_at_resend";
  const pctx = deps.ctxFor(row.workspaceId);
  const clear = () =>
    db.update(emailBroadcasts).set({ resendBroadcastId: null, updatedAt: now }).where(and(eq(emailBroadcasts.id, row.id), eq(emailBroadcasts.resendBroadcastId, resendId)));
  const wentOut = async (rb: ResendBroadcast) => {
    await event(deps, row.id, { type: "sent", at: rb.sentAt ? new Date(rb.sentAt) : now }, WORKER, { data: { cancelReason: data.reason } });
    return "already_sent" as const;
  };

  const rb = await provider.getBroadcast(pctx, resendId);
  if (!rb) {
    await clear();
    return "nothing_at_resend";
  }
  if ((row.status === "approved" || row.status === "scheduled_at_resend") && row.approvalId && approvalOfResendName(rb.name) === row.approvalId) return "current";
  if (rb.status === "sent" || rb.status === "sending" || rb.status === "queued") return wentOut(rb);

  const del = await provider.deleteBroadcast(pctx, resendId);
  if (del.deleted || del.reason === "not_found") {
    await clear();
    await note(db, row, "broadcast.canceled_at_resend", { resendBroadcastId: resendId, reason: data.reason });
    return "canceled";
  }
  const again = await provider.getBroadcast(pctx, resendId).catch(() => null);
  if (again && (again.status === "sent" || again.status === "sending" || again.status === "queued")) return wentOut(again);
  await db.update(emailBroadcasts).set({ lastError: `Couldn't cancel it at Resend: ${del.message} Cancel it in the Resend dashboard.`, updatedAt: now }).where(eq(emailBroadcasts.id, row.id));
  return "not_deletable";
}

/** Poll Resend for scheduled broadcasts past their time (a backstop for missed webhooks). */
export async function reconcileScheduledBroadcasts(deps: EmailJobDeps, opts: { graceMin?: number } = {}): Promise<{ checked: number; sent: number; canceled: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.db
    .select()
    .from(emailBroadcasts)
    .where(and(eq(emailBroadcasts.status, "scheduled_at_resend"), lt(emailBroadcasts.scheduledAt, new Date(now.getTime() - (opts.graceMin ?? 10) * 60_000))));
  const out = { checked: 0, sent: 0, canceled: 0 };
  for (const row of rows) {
    if (!row.resendBroadcastId) continue;
    out.checked++;
    const rb = await deps.provider.getBroadcast(deps.ctxFor(row.workspaceId), row.resendBroadcastId).catch(() => undefined);
    if (rb === undefined) continue;
    if (rb?.status === "sent") {
      if (await event(deps, row.id, { type: "sent", at: rb.sentAt ? new Date(rb.sentAt) : now }, WORKER)) out.sent++;
    } else if (!rb || rb.status === "canceled") {
      if (await event(deps, row.id, { type: "cancel", reason: "Canceled at Resend" }, WORKER, { set: { lastError: "It was canceled or deleted in the Resend dashboard." } })) out.canceled++;
    }
  }
  return out;
}

// ── webhooks ──

/** What the web route stores in webhook_events.body: the normalized event with addresses hashed. */
export interface StoredResendEvent {
  v: 1;
  type: ResendWebhookEvent["type"];
  rawType: string;
  eventId: string;
  createdAt: string | null;
  broadcastId: string | null;
  emailId: string | null;
  toHashes: string[];
  bounceType: string | null;
  contactId: string | null;
  contactEmailHash: string | null;
  unsubscribed: boolean | null;
  audienceIds: string[];
}

export function toStoredResendEvent(e: ResendWebhookEvent): StoredResendEvent {
  return {
    v: 1,
    type: e.type,
    rawType: e.rawType,
    eventId: e.eventId,
    createdAt: e.createdAt,
    broadcastId: e.broadcastId,
    emailId: e.emailId,
    toHashes: e.to.map(hashEmail),
    bounceType: e.bounceType,
    contactId: e.contactId,
    contactEmailHash: e.contactEmail ? hashEmail(e.contactEmail) : null,
    unsubscribed: e.unsubscribed,
    audienceIds: e.audienceIds,
  };
}

export function decodeStoredResendEvent(body: string): StoredResendEvent | null {
  try {
    const o = JSON.parse(body) as Partial<StoredResendEvent>;
    if (o?.v !== 1 || typeof o.type !== "string") return null;
    return { toHashes: [], audienceIds: [], ...o } as StoredResendEvent;
  } catch {
    return null;
  }
}

async function workspaceForAudiences(db: Db, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const [p] = await db
    .select({ ws: products.workspaceId })
    .from(products)
    .where(inArray(sql<string>`${products.emailSettings} ->> 'audienceId'`, ids))
    .limit(1);
  return p?.ws ?? null;
}

/**
 * Which workspace's webhook secret to try, from the unverified body (nothing else is trusted until
 * the signature checks out): the broadcast id names a broadcast, or the audience names a product.
 */
export async function resendWorkspaceHint(db: Db, rawBody: string): Promise<string | null> {
  let body: { data?: Record<string, unknown> };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return null;
  }
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const bid = typeof data.broadcast_id === "string" ? data.broadcast_id : null;
  if (bid) {
    const [b] = await db.select({ ws: emailBroadcasts.workspaceId }).from(emailBroadcasts).where(eq(emailBroadcasts.resendBroadcastId, bid));
    if (b) return b.ws;
  }
  const ids = [data.audience_id, ...(Array.isArray(data.segment_ids) ? data.segment_ids : [])].filter((x): x is string => typeof x === "string" && !!x);
  return workspaceForAudiences(db, ids);
}

const SUPPRESS: Partial<Record<StoredResendEvent["type"], SuppressionReason>> = {
  "email.complained": "complained",
  "email.suppressed": "bounced",
  "contact.unsubscribed": "unsubscribed",
};

export type ResendWebhookOutcome = "duplicate" | "processed" | "ignored" | "no_match";

/**
 * email.webhook: stored rows are the counts (delivered, complaints…); permanent bounces, complaints
 * and unsubscribes go on the suppression list; the first email.sent of a broadcast marks it sent.
 * Idempotent: a row is processed once.
 */
export async function processResendWebhook(deps: EmailJobDeps, webhookEventId: string): Promise<ResendWebhookOutcome> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId));
  if (!row || row.processedAt) return "duplicate";
  const done = (patch: { workspaceId?: string | null; error?: string | null }) =>
    db.update(webhookEvents).set({ processedAt: now, ...patch }).where(eq(webhookEvents.id, row.id));
  const e = decodeStoredResendEvent(row.body);
  if (!e) {
    await done({ error: "could not parse" });
    return "ignored";
  }
  const [bc] = e.broadcastId ? await db.select().from(emailBroadcasts).where(eq(emailBroadcasts.resendBroadcastId, e.broadcastId)) : [];
  const ws = bc?.workspaceId ?? row.workspaceId ?? (await workspaceForAudiences(db, e.audienceIds));

  if (e.type === "email.sent" && bc && bc.status !== "sent" && bc.status !== "draft") {
    await event(deps, bc.id, { type: "sent", at: e.createdAt ? new Date(e.createdAt) : now }, WEBHOOK, { data: { webhookEventId: row.id } });
  }

  const permanentBounce = e.type === "email.bounced" && (e.bounceType ?? "Permanent").toLowerCase() === "permanent";
  const reason: SuppressionReason | undefined = permanentBounce ? "bounced" : SUPPRESS[e.type];
  const hashes = e.type === "contact.unsubscribed" ? (e.contactEmailHash ? [e.contactEmailHash] : []) : e.toHashes;
  if (reason && hashes.length) {
    if (!ws) {
      await done({ error: "no workspace for this event" });
      return "no_match";
    }
    for (const h of hashes) await recordSuppressionHash(db, ws, h, reason, `resend:${e.rawType}`);
  }
  await done({ workspaceId: ws ?? null });
  return e.type === "ignored" ? "ignored" : bc || reason ? "processed" : "no_match";
}

