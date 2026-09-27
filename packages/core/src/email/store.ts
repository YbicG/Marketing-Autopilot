import { and, count, eq, isNull } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { Actor, DbOrTx } from "../publishing/store.ts";
import { transitionBroadcast, type BroadcastEvent, type BroadcastSnapshot, type EmailEffect } from "./state-machine.ts";

const { approvals, auditLog, emailBroadcasts } = schema;

export type BroadcastRow = typeof emailBroadcasts.$inferSelect;

export class BroadcastConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroadcastConflict";
  }
}

export async function loadBroadcast(db: DbOrTx, workspaceId: string, id: string): Promise<BroadcastRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select()
    .from(emailBroadcasts)
    .where(and(eq(emailBroadcasts.id, id), eq(emailBroadcasts.workspaceId, workspaceId)));
  return row ?? null;
}

export async function approvalSeq(db: DbOrTx, broadcastId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(approvals)
    .where(and(eq(approvals.entityType, "broadcast"), eq(approvals.entityId, broadcastId)));
  return Number(r?.n ?? 0);
}

export async function snapshotOf(db: DbOrTx, row: BroadcastRow): Promise<BroadcastSnapshot> {
  return {
    id: row.id,
    status: row.status,
    approvalId: row.approvalId,
    resendBroadcastId: row.resendBroadcastId,
    approvalSeq: await approvalSeq(db, row.id),
  };
}

export interface AppliedBroadcast {
  row: BroadcastRow;
  effects: EmailEffect[];
}

/**
 * Run one machine event against the row and write it: a conditional UPDATE on the status the event
 * was computed from (a concurrent change throws BroadcastConflict), the voided approval, and an
 * audit row. Returns the effects for the caller to apply after its transaction commits.
 */
export async function applyBroadcastEvent(
  db: DbOrTx,
  row: BroadcastRow,
  event: BroadcastEvent,
  actor: Actor,
  opts: { now?: Date; set?: Partial<typeof emailBroadcasts.$inferInsert>; data?: Record<string, unknown> } = {},
): Promise<AppliedBroadcast> {
  const now = opts.now ?? new Date();
  const t = transitionBroadcast(await snapshotOf(db, row), event);
  if (!t.ok) throw new BroadcastConflict(t.error);
  const updated = await db
    .update(emailBroadcasts)
    .set({ ...t.patch, ...opts.set, status: t.patch.status, updatedAt: now })
    .where(and(eq(emailBroadcasts.id, row.id), eq(emailBroadcasts.status, row.status)))
    .returning();
  if (!updated.length) throw new BroadcastConflict("This broadcast changed while we were working on it. Reload and try again.");
  if (t.voidApprovalId) {
    await db
      .update(approvals)
      .set({ voidedAt: now, voidReason: event.type === "void_approval" ? event.reason : event.type })
      .where(and(eq(approvals.id, t.voidApprovalId), isNull(approvals.voidedAt)));
  }
  if (t.from !== t.to || event.type === "approve" || event.type === "edit") {
    await db.insert(auditLog).values({
      id: uuidv7(),
      workspaceId: row.workspaceId,
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: `broadcast.${event.type}`,
      entity: `broadcast:${row.id}`,
      data: { from: t.from, to: t.to, ...(opts.data ?? {}) },
    });
  }
  return { row: updated[0]!, effects: t.effects };
}

/** One transaction around applyBroadcastEvent, re-reading the row first. */
export async function commitBroadcastEvent(
  db: Db,
  workspaceId: string,
  id: string,
  event: BroadcastEvent,
  actor: Actor,
  opts: { now?: Date; set?: Partial<typeof emailBroadcasts.$inferInsert>; data?: Record<string, unknown> } = {},
): Promise<AppliedBroadcast | null> {
  return db.transaction(async (tx) => {
    const row = await loadBroadcast(tx, workspaceId, id);
    if (!row) return null;
    return applyBroadcastEvent(tx, row, event, actor, opts);
  });
}

// ── effects → queue jobs ──

export interface EmailJobSpec {
  queue: "publish";
  name: "email.submit" | "email.cancel";
  data: { broadcastId: string } | { broadcastId: string; reason: string };
  jobId: string;
  delayMs?: number;
}

export function emailJobsFor(effects: readonly EmailEffect[]): EmailJobSpec[] {
  return effects.map((e) =>
    e.type === "submit"
      ? { queue: "publish", name: "email.submit", data: { broadcastId: e.broadcastId }, jobId: e.jobId, ...(e.delayMs ? { delayMs: e.delayMs } : {}) }
      : { queue: "publish", name: "email.cancel", data: { broadcastId: e.broadcastId, reason: e.reason }, jobId: e.jobId },
  );
}

/** What the web app and the worker pass in: enqueue one job on the publish queue. */
export type EmailEnqueue = (job: EmailJobSpec) => Promise<void>;

/** Apply effects after the DB transaction committed (the web's applyEffects equivalent for email). */
export async function applyEmailEffects(enqueue: EmailEnqueue, effects: readonly EmailEffect[]): Promise<void> {
  for (const j of emailJobsFor(effects)) await enqueue(j);
}
