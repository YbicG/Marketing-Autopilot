import { and, desc, eq, inArray } from "drizzle-orm";
import {
  BroadcastPatch,
  BroadcastSettings,
  broadcastBodyText,
  broadcastParagraphs,
  type EmailIssue,
} from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { BroadcastState } from "@mkt/db/schema";
import type { UiSession } from "../publishing/approvals.ts";
import { canonicalJson } from "../publishing/hash.ts";
import type { Actor } from "../publishing/store.ts";
import { broadcastContext, checkRow, hashRow, renderRow, settingsOf } from "./context.ts";
import type { EmailSettingsLike } from "./render.ts";
import { broadcastStatusLabel, EDITABLE_STATES, RESEND_LIVE_STATES, type EmailEffect } from "./state-machine.ts";
import { applyBroadcastEvent, approvalSeq, BroadcastConflict, loadBroadcast, type BroadcastRow } from "./store.ts";
import { broadcastStats, type BroadcastStats } from "./suppression.ts";
import { emailHasBlock } from "./validate.ts";

const { approvals, auditLog, emailBroadcasts, products } = schema;

export type EmailActionResult<T = object> = ({ ok: true; effects: EmailEffect[] } & T) | { ok: false; reason: string; issues?: EmailIssue[] };

// ── read models ──

export interface BroadcastSummary {
  id: string;
  name: string;
  subject: string;
  status: BroadcastState;
  statusLabel: string;
  scheduledAt: string | null;
  sentAt: string | null;
  audienceLabel: string | null;
  blocking: number;
  warnings: number;
  lastError: string | null;
  updatedAt: string;
}

export interface BroadcastView extends BroadcastSummary {
  productId: string;
  launchPlanId: string | null;
  preheader: string | null;
  /** Editor text: paragraphs separated by a blank line, links as {{link:landing}}. */
  body: string;
  paragraphs: string[];
  claimRefs: string[];
  audienceId: string | null;
  issues: EmailIssue[];
  /** Rendered from the current text, for a sandboxed preview iframe (no allow-same-origin). */
  preview: { html: string; text: string; from: string | null; replyTo: string | null };
  stats: BroadcastStats | null;
  canEdit: boolean;
  canApprove: boolean;
  canCancel: boolean;
  /** True while Resend holds it on a timer; editing now cancels it there. */
  scheduledAtResend: boolean;
  runId: string | null;
}

function summary(r: BroadcastRow): BroadcastSummary {
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    status: r.status,
    statusLabel: broadcastStatusLabel(r.status),
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    audienceLabel: r.audienceLabel,
    blocking: r.issues.filter((i) => i.severity === "block").length,
    warnings: r.issues.filter((i) => i.severity === "warn").length,
    lastError: r.lastError,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listBroadcasts(db: Db, workspaceId: string, productId: string): Promise<BroadcastSummary[]> {
  const rows = await db
    .select()
    .from(emailBroadcasts)
    .where(and(eq(emailBroadcasts.workspaceId, workspaceId), eq(emailBroadcasts.productId, productId)))
    .orderBy(desc(emailBroadcasts.createdAt));
  return rows.map(summary);
}

export async function broadcastView(db: Db, workspaceId: string, id: string): Promise<BroadcastView | null> {
  const row = await loadBroadcast(db, workspaceId, id);
  if (!row) return null;
  const ctx = await broadcastContext(db, row);
  if (!ctx) return null;
  const r = renderRow(row, ctx);
  const s = ctx.settings;
  return {
    ...summary(row),
    productId: row.productId,
    launchPlanId: row.launchPlanId,
    preheader: row.preheader,
    body: row.body,
    paragraphs: broadcastParagraphs(row.body),
    claimRefs: row.claimIds,
    audienceId: row.audienceId,
    issues: row.issues as EmailIssue[],
    preview: {
      html: r.html,
      text: r.text,
      from: s?.fromEmail ? `${s.fromName ?? ""} <${s.fromEmail}>`.trim() : null,
      replyTo: s?.replyTo ?? s?.fromEmail ?? null,
    },
    stats: row.resendBroadcastId ? await broadcastStats(db, row.resendBroadcastId) : null,
    canEdit: EDITABLE_STATES.includes(row.status),
    canApprove: row.status === "pending_approval" && !emailHasBlock(row.issues as EmailIssue[]),
    canCancel: row.status !== "sent" && row.status !== "canceled",
    scheduledAtResend: row.status === "scheduled_at_resend",
    runId: row.runId,
  };
}

// ── editing ──

const CONTENT_FIELDS = ["subject", "preheader", "body", "claimIds", "audienceId", "scheduledAt"] as const;

/**
 * Editor save. Any change to what Resend would receive is the machine's `edit`: after approval the
 * broadcast goes back for approval, and if Resend already holds it an email.cancel effect is
 * returned ("Editing a broadcast cancels it at Resend", M4-LC). Name-only changes are just saved.
 */
export async function saveBroadcast(
  db: Db,
  workspaceId: string,
  id: string,
  patch: unknown,
  userId: string,
  opts: { now?: Date } = {},
): Promise<EmailActionResult<{ view: BroadcastView }>> {
  const now = opts.now ?? new Date();
  const parsed = BroadcastPatch.safeParse(patch);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => i.message).join(" ") };
  const p = parsed.data;
  const actor: Actor = { type: "user", id: userId };
  let res: { effects: EmailEffect[] };
  try {
    res = await db.transaction(async (tx) => {
      const row = await loadBroadcast(tx, workspaceId, id);
      if (!row) throw new BroadcastConflict("Broadcast not found.");
      if (!EDITABLE_STATES.includes(row.status)) throw new BroadcastConflict(`This broadcast is ${broadcastStatusLabel(row.status).toLowerCase()} and can't be changed.`);
      const set: Partial<typeof emailBroadcasts.$inferInsert> = {};
      if (p.name !== undefined) set.name = p.name.trim();
      if (p.subject !== undefined) set.subject = p.subject.replace(/[\r\n]+/g, " ").trim();
      if (p.preheader !== undefined) set.preheader = p.preheader?.replace(/[\r\n]+/g, " ").trim() || null;
      if (p.body !== undefined) set.body = broadcastBodyText(broadcastParagraphs(p.body));
      if (p.claimRefs !== undefined) set.claimIds = [...new Set(p.claimRefs)];
      if (p.audienceId !== undefined) set.audienceId = p.audienceId;
      if (p.audienceLabel !== undefined) set.audienceLabel = p.audienceLabel;
      if (p.scheduledAt !== undefined) set.scheduledAt = p.scheduledAt ? new Date(p.scheduledAt) : null;
      const changed = CONTENT_FIELDS.some((k) => k in set && canonicalJson(set[k] ?? null) !== canonicalJson(row[k] ?? null));

      const next = { ...row, ...set } as BroadcastRow;
      const ctx = await broadcastContext(tx, next);
      const issues = ctx ? await checkRow(tx, next, ctx, now, renderRow(next, ctx)) : [];
      const fullSet = { ...set, issues, ...(changed ? { html: null, text: null, contentHash: null } : {}) };
      if (!changed) {
        await tx.update(emailBroadcasts).set({ ...fullSet, updatedAt: now }).where(eq(emailBroadcasts.id, row.id));
        return { effects: [] };
      }
      const ready = next.subject.trim() && next.body.trim();
      const event = row.status === "draft" && ready ? ({ type: "submit_for_approval" } as const) : ({ type: "edit" } as const);
      const r = await applyBroadcastEvent(tx, row, event, actor, { now, set: fullSet, data: { fields: Object.keys(set) } });
      return { effects: r.effects };
    });
  } catch (err) {
    if (err instanceof BroadcastConflict) return { ok: false, reason: err.message };
    throw err;
  }
  const view = await broadcastView(db, workspaceId, id);
  return { ok: true, effects: res.effects, view: view! };
}

/**
 * Approve (D9): only a UiSession, minted by the web app from a cookie session with Origin + CSRF
 * checks. Renders html/text with the footer, runs every §8 email check, writes the approvals row
 * (content_hash = subject + html + text + audience + send time + sender) and an audit row, then
 * pending_approval → approved with an email.submit effect.
 */
export async function approveBroadcast(db: Db, session: UiSession, id: string, opts: { now?: Date } = {}): Promise<EmailActionResult<{ approvalId: string }>> {
  if (!session?.userId || !session.workspaceId) throw new Error("A signed-in UI session is required to approve");
  const now = opts.now ?? new Date();
  const actor: Actor = { type: "user", id: session.userId };
  return db.transaction(async (tx) => {
    const row = await loadBroadcast(tx, session.workspaceId, id);
    if (!row) return { ok: false as const, reason: "Broadcast not found." };
    if (row.status !== "pending_approval") return { ok: false as const, reason: `This broadcast is ${broadcastStatusLabel(row.status).toLowerCase()}, not waiting for approval.` };
    const ctx = await broadcastContext(tx, row);
    if (!ctx) return { ok: false as const, reason: "This broadcast's product is missing." };
    const rendered = renderRow(row, ctx);
    const issues = await checkRow(tx, row, ctx, now, rendered);
    if (emailHasBlock(issues)) {
      await tx.update(emailBroadcasts).set({ issues, updatedAt: now }).where(eq(emailBroadcasts.id, row.id));
      return { ok: false as const, reason: issues.find((i) => i.severity === "block")!.message, issues };
    }
    const hash = hashRow({ ...row, html: rendered.html, text: rendered.text }, ctx.settings);
    if (!hash) return { ok: false as const, reason: "Add the sender, audience and send time first." };
    const approvalId = uuidv7();
    await tx.insert(approvals).values({
      id: approvalId,
      workspaceId: row.workspaceId,
      entityType: "broadcast",
      entityId: row.id,
      contentHash: hash,
      approvedBy: session.userId,
    });
    const seq = await approvalSeq(tx, row.id);
    const r = await applyBroadcastEvent(tx, row, { type: "approve", approvalId, seq }, actor, {
      now,
      set: { html: rendered.html, text: rendered.text, contentHash: hash, issues },
      data: { approvalId, contentHash: hash, scheduledAt: row.scheduledAt?.toISOString() ?? null, audienceId: row.audienceId },
    });
    return { ok: true as const, approvalId, effects: r.effects };
  });
}

async function simpleEvent(
  db: Db,
  workspaceId: string,
  id: string,
  event: Parameters<typeof applyBroadcastEvent>[2],
  actor: Actor,
  now: Date,
): Promise<EmailActionResult> {
  try {
    return await db.transaction(async (tx) => {
      const row = await loadBroadcast(tx, workspaceId, id);
      if (!row) return { ok: false as const, reason: "Broadcast not found." };
      const r = await applyBroadcastEvent(tx, row, event, actor, { now });
      return { ok: true as const, effects: r.effects };
    });
  } catch (err) {
    if (err instanceof BroadcastConflict) return { ok: false, reason: err.message };
    throw err;
  }
}

/** Take back an approval. Any actor may: it only ever removes permission to send (cancels at Resend if scheduled). */
export function voidBroadcast(db: Db, workspaceId: string, id: string, reason: string, actor: Actor, opts: { now?: Date } = {}) {
  return simpleEvent(db, workspaceId, id, { type: "void_approval", reason }, actor, opts.now ?? new Date());
}

/** Drop the broadcast for good (canceled at Resend when it's scheduled there). */
export function cancelBroadcast(db: Db, workspaceId: string, id: string, actor: Actor, opts: { now?: Date; reason?: string } = {}) {
  return simpleEvent(db, workspaceId, id, { type: "cancel", reason: opts.reason ?? "Canceled" }, actor, opts.now ?? new Date());
}

/** "Try again" on a failed broadcast: back to approval (and whatever Resend holds is canceled). */
export function retryBroadcast(db: Db, workspaceId: string, id: string, actor: Actor, opts: { now?: Date } = {}) {
  return simpleEvent(db, workspaceId, id, { type: "edit" }, actor, opts.now ?? new Date());
}

/**
 * "Pause all posting" (§5.8 step 5) for email: approved and Resend-scheduled broadcasts go back for
 * approval, and scheduled ones are canceled at Resend. productId null = the whole workspace.
 */
export async function pauseBroadcasts(db: Db, workspaceId: string, productId: string | null, actor: Actor, opts: { now?: Date } = {}): Promise<{ paused: number; effects: EmailEffect[] }> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({ id: emailBroadcasts.id })
    .from(emailBroadcasts)
    .where(
      and(
        eq(emailBroadcasts.workspaceId, workspaceId),
        inArray(emailBroadcasts.status, [...RESEND_LIVE_STATES]),
        ...(productId ? [eq(emailBroadcasts.productId, productId)] : []),
      ),
    );
  const effects: EmailEffect[] = [];
  let paused = 0;
  for (const { id } of rows) {
    const r = await simpleEvent(db, workspaceId, id, { type: "pause" }, actor, now);
    if (r.ok) {
      paused++;
      effects.push(...r.effects);
    }
  }
  if (rows.length) {
    await db.insert(auditLog).values({
      id: uuidv7(),
      workspaceId,
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: "broadcasts.pause",
      entity: productId ? `product:${productId}` : "workspace",
      data: { paused },
    });
  }
  return { paused, effects };
}

// ── sender settings (products.email_settings) ──

export interface EmailSettingsView {
  settings: EmailSettingsLike | null;
  /** Plain sentences for what's still missing before a broadcast can be approved. */
  missing: string[];
}

export function missingSettings(s: EmailSettingsLike | null): string[] {
  const out: string[] = [];
  if (!s?.fromName || !s.fromEmail) out.push("Who it's from (a name and an address on your sending domain)");
  if (!s?.postalAddress) out.push("A postal address");
  if (!s?.consentSource) out.push("Where these contacts came from");
  if (!s?.audienceId) out.push("Which Resend list to send to");
  if (s?.euConsentAck !== true) out.push("Confirm that EU/UK contacts agreed to hear from you");
  return out;
}

export async function emailSettingsView(db: Db, workspaceId: string, productId: string): Promise<EmailSettingsView | null> {
  const [p] = await db.select().from(products).where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  if (!p) return null;
  const settings = settingsOf(p);
  return { settings, missing: missingSettings(settings) };
}

/**
 * Save the sender identity. The from, reply-to and footer are part of what was approved, so any
 * change sends approved or scheduled broadcasts of this product back for approval.
 */
export async function saveEmailSettings(
  db: Db,
  workspaceId: string,
  productId: string,
  input: unknown,
  actor: Actor,
  opts: { now?: Date } = {},
): Promise<EmailActionResult<{ settings: BroadcastSettings }>> {
  const parsed = BroadcastSettings.safeParse(input);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" ") };
  const settings = parsed.data;
  const [p] = await db.select().from(products).where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  if (!p) return { ok: false, reason: "Product not found." };
  if (canonicalJson(p.emailSettings ?? null) === canonicalJson(settings)) return { ok: true, effects: [], settings };
  await db
    .update(products)
    .set({ emailSettings: settings as unknown as typeof products.$inferInsert.emailSettings })
    .where(eq(products.id, productId));
  await db.insert(auditLog).values({
    id: uuidv7(),
    workspaceId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: "email_settings.save",
    entity: `product:${productId}`,
    data: { fields: Object.keys(settings) },
  });
  const live = await db
    .select({ id: emailBroadcasts.id })
    .from(emailBroadcasts)
    .where(and(eq(emailBroadcasts.workspaceId, workspaceId), eq(emailBroadcasts.productId, productId), inArray(emailBroadcasts.status, [...RESEND_LIVE_STATES])));
  const effects: EmailEffect[] = [];
  for (const { id } of live) {
    const r = await simpleEvent(db, workspaceId, id, { type: "edit" }, actor, opts.now ?? new Date());
    if (r.ok) effects.push(...r.effects);
  }
  return { ok: true, effects, settings };
}
