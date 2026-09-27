import { and, between, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type {
  LandingAuditView,
  LaunchCountdown,
  LaunchDayNumbers,
  LaunchDayPost,
  LaunchDayView,
  LaunchGateResult,
  LaunchGateSummary,
  LaunchRefHint,
  LaunchTaskGroup,
  LaunchTaskStatus,
  LaunchTaskView,
  LaunchTemplate,
  LaunchView,
} from "@mkt/contracts";
import { LAUNCH_MODE_LABELS } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { DbOrTx } from "../../publishing/store.ts";
import { localDay } from "../../publishing/time.ts";
import { addDays, dayBounds } from "../../publishing/zoned.ts";
import {
  buildLaunchTasks,
  dayLabel,
  daysBetween,
  evaluateTasks,
  LaunchPlanError,
  refFromHint,
  weekGroup,
  type BuiltLaunchTask,
  type ContentRangeFacts,
  type EvalTask,
  type KitFactStatus,
  type LaunchFacts,
  type TaskEvaluation,
} from "./schedule.ts";
import { launchTemplate, LAUNCH_TEMPLATE_VERSION } from "./template.ts";

const { analyticsSnapshots, auditLog, campaigns, contentItems, conversionSnapshots, emailBroadcasts, landingAudits, launchKits, launchPlans, launchTasks, posts, variants, workspaces } =
  schema;

export type LaunchPlanRow = typeof launchPlans.$inferSelect;
export type LaunchTaskRow = typeof launchTasks.$inferSelect;

/** Post states that count as approved for the checklist (queued or further along, §4.3). */
const APPROVED_POST_STATES = new Set(["approved", "queued", "preparing", "submitting", "submitted", "unknown", "awaiting_user", "published"]);
const TERMINAL = new Set<LaunchTaskStatus>(["done", "skipped"]);
/** M4 done-when: ≥90% of the Auto items for D1–D19 approved by D1 − 3 (Jan 3 for SyllaCal). */
export const AUTO_APPROVAL_TARGET = { fromDay: 1, toDay: 19, targetPct: 90, daysBeforeStart: 3 } as const;

async function tzOf(db: DbOrTx, workspaceId: string): Promise<string> {
  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws?.tz ?? "America/New_York";
}

async function audit(db: DbOrTx, workspaceId: string, actor: { type: "user" | "worker"; id: string | null }, action: string, entity: string, data: Record<string, unknown>) {
  await db.insert(auditLog).values({ id: uuidv7(), workspaceId, actorType: actor.type, actorId: actor.id, action, entity, data });
}

/** The product's active plan (newest first). */
export async function activeLaunchPlan(db: DbOrTx, workspaceId: string, productId: string): Promise<LaunchPlanRow | null> {
  const [plan] = await db
    .select()
    .from(launchPlans)
    .where(and(eq(launchPlans.workspaceId, workspaceId), eq(launchPlans.productId, productId), eq(launchPlans.status, "active")))
    .orderBy(desc(launchPlans.createdAt))
    .limit(1);
  return plan ?? null;
}

async function planTasks(db: DbOrTx, plan: LaunchPlanRow): Promise<LaunchTaskRow[]> {
  return db.select().from(launchTasks).where(and(eq(launchTasks.launchPlanId, plan.id), eq(launchTasks.workspaceId, plan.workspaceId)));
}

function taskRef(b: BuiltLaunchTask, campaignId: string): Record<string, string> {
  return refFromHint(b.refHint, b.refHint.kind === "content_range" ? { campaignId } : {});
}

// ── create / re-date ──

export interface CreateLaunchPlanResult {
  planId: string;
  created: boolean;
  /** The campaign's dates changed since the plan was made; open tasks were re-dated. */
  redated: boolean;
  /** Template tasks added to an existing plan. */
  added: string[];
  /** Open tasks already past their due date: shown in the overdue list, never dropped. */
  overdue: string[];
}

/**
 * One active plan per product, idempotent per campaign. Re-running re-dates the tasks that aren't
 * done or skipped when the campaign's dates moved, and keeps done/skipped ones as they are.
 */
export async function createLaunchPlan(
  db: Db,
  workspaceId: string,
  input: { campaignId: string; optionalOn?: Iterable<string>; now?: Date; userId?: string },
): Promise<CreateLaunchPlanResult> {
  const now = input.now ?? new Date();
  const optionalOn = new Set(input.optionalOn ?? []);
  const actor = input.userId ? { type: "user" as const, id: input.userId } : { type: "worker" as const, id: null };
  const result = await db.transaction(async (tx) => {
    const [campaign] = await tx.select().from(campaigns).where(and(eq(campaigns.id, input.campaignId), eq(campaigns.workspaceId, workspaceId)));
    if (!campaign) throw new LaunchPlanError("Campaign not found.", "not_found");
    const tz = await tzOf(tx, workspaceId);
    const today = localDay(now, tz);
    const [existing] = await tx
      .select()
      .from(launchPlans)
      .where(and(eq(launchPlans.workspaceId, workspaceId), eq(launchPlans.campaignId, campaign.id)))
      .orderBy(desc(launchPlans.createdAt))
      .limit(1);
    const template = launchTemplate(existing?.templateVersion ?? LAUNCH_TEMPLATE_VERSION);
    const built = buildLaunchTasks(template, { launchDate: campaign.launchDate, startDate: campaign.startDate, timeZone: tz, today: now, optionalOn });

    // One active plan per product: an older campaign's plan steps aside.
    await tx
      .update(launchPlans)
      .set({ status: "done", updatedAt: now })
      .where(
        and(
          eq(launchPlans.workspaceId, workspaceId),
          eq(launchPlans.productId, campaign.productId),
          eq(launchPlans.status, "active"),
          ...(existing ? [ne(launchPlans.id, existing.id)] : []),
        ),
      );

    if (!existing) {
      const planId = uuidv7();
      await tx.insert(launchPlans).values({
        id: planId,
        workspaceId,
        productId: campaign.productId,
        campaignId: campaign.id,
        startDate: campaign.startDate,
        launchDate: campaign.launchDate,
        status: "active",
        templateVersion: template.version,
      });
      await tx.insert(launchTasks).values(
        built.map((b) => ({
          id: uuidv7(),
          workspaceId,
          launchPlanId: planId,
          key: b.key,
          title: b.title,
          detail: b.detail,
          mode: b.mode,
          dayOffset: b.dayOffset,
          dueDate: b.dueDate,
          dependsOn: b.dependsOn,
          status: b.status,
          ref: taskRef(b, campaign.id),
        })),
      );
      const overdue = built.filter((b) => b.overdueAtCreation).map((b) => b.key);
      await audit(tx, workspaceId, actor, "launch.plan.created", `launch_plan:${planId}`, { campaignId: campaign.id, launchDate: campaign.launchDate, overdue });
      return { planId, created: true, redated: false, added: [], overdue };
    }

    const redated = existing.launchDate !== campaign.launchDate || existing.startDate !== campaign.startDate;
    await tx
      .update(launchPlans)
      .set({ startDate: campaign.startDate, launchDate: campaign.launchDate, status: "active", updatedAt: now })
      .where(eq(launchPlans.id, existing.id));
    const rows = new Map((await planTasks(tx, existing)).map((r) => [r.key, r]));
    const added: string[] = [];
    for (const b of built) {
      const row = rows.get(b.key);
      if (!row) {
        added.push(b.key);
        await tx.insert(launchTasks).values({
          id: uuidv7(),
          workspaceId,
          launchPlanId: existing.id,
          key: b.key,
          title: b.title,
          detail: b.detail,
          mode: b.mode,
          dayOffset: b.dayOffset,
          dueDate: b.dueDate,
          dependsOn: b.dependsOn,
          status: b.status,
          ref: taskRef(b, campaign.id),
        });
        continue;
      }
      const turnOn = b.optional && optionalOn.has(b.key) && row.status === "skipped";
      const open = !TERMINAL.has(row.status) || turnOn;
      if (!open) continue;
      const patch: Partial<typeof launchTasks.$inferInsert> = {};
      if (row.dueDate !== b.dueDate || row.dayOffset !== b.dayOffset) Object.assign(patch, { dueDate: b.dueDate, dayOffset: b.dayOffset });
      if (turnOn) patch.status = "todo";
      if (b.refHint.kind === "content_range" && row.ref?.campaignId !== campaign.id) patch.ref = { ...(row.ref ?? {}), ...taskRef(b, campaign.id) };
      if (Object.keys(patch).length) await tx.update(launchTasks).set(patch).where(eq(launchTasks.id, row.id));
    }
    if (redated || added.length) {
      await audit(tx, workspaceId, actor, "launch.plan.redated", `launch_plan:${existing.id}`, {
        from: { startDate: existing.startDate, launchDate: existing.launchDate },
        to: { startDate: campaign.startDate, launchDate: campaign.launchDate },
        added,
      });
    }
    const finalRows = await planTasks(tx, existing);
    const overdue = finalRows.filter((r) => !TERMINAL.has(r.status) && r.status !== "scheduled" && r.dueDate < today).map((r) => r.key);
    return { planId: existing.id, created: false, redated, added, overdue };
  });
  await refreshLaunchPlan(db, workspaceId, result.planId, now);
  return result;
}

// ── facts + evaluation ──

interface TemplateIndex {
  template: LaunchTemplate;
  byKey: Map<string, BuiltLaunchTask>;
}

function indexTemplate(plan: LaunchPlanRow, tz: string, now: Date): TemplateIndex {
  const template = launchTemplate(plan.templateVersion);
  const built = buildLaunchTasks(template, { launchDate: plan.launchDate, startDate: plan.startDate, timeZone: tz, today: now });
  return { template, byKey: new Map(built.map((b) => [b.key, b])) };
}

function refHintOf(row: LaunchTaskRow, idx: TemplateIndex): LaunchRefHint {
  const t = idx.byKey.get(row.key);
  if (t) return t.refHint;
  const kind = (row.ref?.kind ?? "none") as LaunchRefHint["kind"];
  return { kind };
}

function toEvalTasks(rows: readonly LaunchTaskRow[], idx: TemplateIndex): EvalTask[] {
  const keys = new Set(rows.map((r) => r.key));
  return rows.map((r) => {
    const t = idx.byKey.get(r.key);
    return {
      key: r.key,
      title: r.title,
      mode: r.mode,
      dueDate: r.dueDate,
      opensOn: t?.opensOn ?? null,
      // A dependency whose row is missing (older plan) can't block anything.
      dependsOn: r.dependsOn.filter((d) => keys.has(d)),
      status: r.status,
      gate: r.gate ?? null,
      refHint: refHintOf(r, idx),
    };
  });
}

/** Approved/published counts per content item for a campaign's day range (open slots not yet filled don't count). */
export async function contentRangeFacts(db: DbOrTx, workspaceId: string, campaignId: string, fromDay: number, toDay: number): Promise<ContentRangeFacts> {
  const items = await db
    .select({ id: contentItems.id, status: contentItems.status, slotKind: contentItems.slotKind })
    .from(contentItems)
    .where(
      and(eq(contentItems.workspaceId, workspaceId), eq(contentItems.campaignId, campaignId), between(contentItems.day, fromDay, toDay), ne(contentItems.status, "skipped")),
    );
  const planned = items.filter((i) => !(i.slotKind === "open" && i.status === "planned"));
  if (!planned.length) return { total: 0, approved: 0, published: 0 };
  const postRows = await db
    .select({ itemId: variants.contentItemId, state: posts.state })
    .from(posts)
    .innerJoin(variants, eq(variants.id, posts.variantId))
    .where(
      and(
        eq(posts.workspaceId, workspaceId),
        inArray(
          variants.contentItemId,
          planned.map((i) => i.id),
        ),
        ne(posts.state, "canceled"),
      ),
    );
  const byItem = new Map<string, string[]>();
  for (const p of postRows) byItem.set(p.itemId, [...(byItem.get(p.itemId) ?? []), p.state]);
  let approved = 0;
  let published = 0;
  for (const i of planned) {
    const states = byItem.get(i.id) ?? [];
    if (states.length ? states.every((s) => APPROVED_POST_STATES.has(s)) : i.status === "approved") approved++;
    if (states.length && states.every((s) => s === "published")) published++;
  }
  return { total: planned.length, approved, published };
}

export async function gatherLaunchFacts(db: DbOrTx, plan: LaunchPlanRow, rows: readonly LaunchTaskRow[], idx: TemplateIndex): Promise<LaunchFacts> {
  const contentRanges: Record<string, ContentRangeFacts> = {};
  for (const r of rows) {
    const hint = refHintOf(r, idx);
    if (hint.kind !== "content_range" || TERMINAL.has(r.status)) continue;
    const campaignId = r.ref?.campaignId ?? plan.campaignId;
    if (!campaignId || hint.fromDay === undefined || hint.toDay === undefined) continue;
    contentRanges[r.key] = await contentRangeFacts(db, plan.workspaceId, campaignId, hint.fromDay, hint.toDay);
  }
  const kitRows = await db
    .select({ id: launchKits.id, kind: launchKits.kind, status: launchKits.status, needsYouReason: launchKits.needsYouReason })
    .from(launchKits)
    .where(and(eq(launchKits.workspaceId, plan.workspaceId), eq(launchKits.launchPlanId, plan.id)));
  const kits: LaunchFacts["kits"] = {};
  for (const k of kitRows) kits[k.kind] = { id: k.id, status: k.status as KitFactStatus, needsYouReason: k.needsYouReason };
  // The seasonal email: the one tied to this plan, else the product's newest one not tied to any plan.
  const [b] = await db
    .select({ id: emailBroadcasts.id, status: emailBroadcasts.status, body: emailBroadcasts.body, planId: emailBroadcasts.launchPlanId })
    .from(emailBroadcasts)
    .where(
      and(
        eq(emailBroadcasts.workspaceId, plan.workspaceId),
        eq(emailBroadcasts.productId, plan.productId),
        or(eq(emailBroadcasts.launchPlanId, plan.id), isNull(emailBroadcasts.launchPlanId)),
      ),
    )
    .orderBy(desc(sql`(${emailBroadcasts.launchPlanId} = ${plan.id}) is true`), desc(emailBroadcasts.createdAt))
    .limit(1);
  return { contentRanges, kits, broadcast: b ? { id: b.id, status: b.status, hasBody: b.body.trim().length > 0 } : null };
}

async function evaluatePlan(db: DbOrTx, plan: LaunchPlanRow, now: Date) {
  const tz = await tzOf(db, plan.workspaceId);
  const today = localDay(now, tz);
  const idx = indexTemplate(plan, tz, now);
  const rows = await planTasks(db, plan);
  const facts = await gatherLaunchFacts(db, plan, rows, idx);
  const evals = evaluateTasks(toEvalTasks(rows, idx), facts, today);
  return { tz, today, idx, rows, facts, evals };
}

/**
 * Evaluate and write the plan's task statuses (launch.tick, and after every change). Gate rows
 * keep the invariant status "done" iff gate.passed.
 */
export async function refreshLaunchPlan(db: DbOrTx, workspaceId: string, planId: string, now = new Date()): Promise<{ changed: string[] }> {
  const [plan] = await db.select().from(launchPlans).where(and(eq(launchPlans.id, planId), eq(launchPlans.workspaceId, workspaceId)));
  if (!plan) throw new LaunchPlanError("Launch plan not found.", "not_found");
  const { rows, evals } = await evaluatePlan(db, plan, now);
  const changed: string[] = [];
  for (const [i, row] of rows.entries()) {
    const e = evals[i]!;
    const refPatch = e.refPatch && Object.entries(e.refPatch).some(([k, v]) => row.ref?.[k] !== v) ? { ...(row.ref ?? {}), ...e.refPatch } : null;
    if (e.status === row.status && !refPatch) continue;
    const patch: Partial<typeof launchTasks.$inferInsert> = {};
    if (e.status !== row.status) {
      patch.status = e.status;
      if (e.status === "done" && !row.doneAt) Object.assign(patch, { doneAt: now, doneBy: "app" });
      if (e.status !== "done" && row.doneAt) Object.assign(patch, { doneAt: null, doneBy: null });
      changed.push(row.key);
    }
    if (refPatch) patch.ref = refPatch;
    await db.update(launchTasks).set(patch).where(eq(launchTasks.id, row.id));
  }
  if (changed.length) await db.update(launchPlans).set({ updatedAt: now }).where(eq(launchPlans.id, plan.id));
  return { changed };
}

/** Write a gate's check result; status follows it (done iff passed), then dependents re-evaluate. */
export async function writeGateResult(db: DbOrTx, workspaceId: string, task: LaunchTaskRow, result: LaunchGateResult, opts: { ref?: Record<string, string>; now?: Date } = {}): Promise<void> {
  if (task.mode !== "gate") throw new LaunchPlanError("Only gates take a check result.", "gate_manual");
  const now = opts.now ?? new Date();
  await db
    .update(launchTasks)
    .set({
      gate: result,
      status: result.passed ? "done" : "todo",
      ...(result.passed ? { doneAt: task.doneAt ?? now, doneBy: "check" } : { doneAt: null, doneBy: null }),
      ...(opts.ref ? { ref: { ...(task.ref ?? {}), ...opts.ref } } : {}),
    })
    .where(and(eq(launchTasks.id, task.id), eq(launchTasks.workspaceId, workspaceId)));
  if (task.status === "done" && !result.passed) {
    await audit(db, workspaceId, { type: "worker", id: null }, "launch.gate.reopened", `launch_task:${task.id}`, { key: task.key, reasons: result.reasons });
  }
  await refreshLaunchPlan(db, workspaceId, task.launchPlanId, now);
}

async function gateRow(db: DbOrTx, workspaceId: string, planId: string, key: string): Promise<LaunchTaskRow | null> {
  const [row] = await db
    .select()
    .from(launchTasks)
    .where(and(eq(launchTasks.workspaceId, workspaceId), eq(launchTasks.launchPlanId, planId), eq(launchTasks.key, key), eq(launchTasks.mode, "gate")));
  return row ?? null;
}

// ── read models ──

function taskView(row: LaunchTaskRow, e: TaskEvaluation, idx: TemplateIndex, titles: Map<string, string>): LaunchTaskView {
  const t = idx.byKey.get(row.key);
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    detail: row.detail,
    mode: row.mode,
    modeLabel: LAUNCH_MODE_LABELS[row.mode],
    dayOffset: row.dayOffset,
    dayLabel: dayLabel(row.dayOffset),
    dueDate: row.dueDate,
    status: e.status,
    optional: t?.optional ?? false,
    overdue: e.overdue,
    blockedBy: e.blockedBy.map((k) => titles.get(k) ?? k),
    reasons: e.reasons,
    ref: row.ref ?? null,
    gate: row.gate ?? null,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    canTick: row.mode !== "gate",
  };
}

function countdown(launchDate: string, today: string): LaunchCountdown {
  const daysToLaunch = daysBetween(today, launchDate);
  return { launchDate, today, daysToLaunch, isLaunchDay: daysToLaunch === 0, isPast: daysToLaunch < 0 };
}

function gateSummary(planId: string, views: readonly LaunchTaskView[]): LaunchGateSummary {
  const gates = views
    .filter((v) => v.mode === "gate")
    .map((v) => ({ key: v.key, taskId: v.id, title: v.title, passed: v.status === "done", reasons: v.status === "done" ? [] : v.reasons, checkedAt: v.gate?.checkedAt ?? null }));
  return { planId, allPassed: gates.length > 0 && gates.every((g) => g.passed), gates };
}

function auditView(a: typeof landingAudits.$inferSelect): LandingAuditView {
  return {
    id: a.id,
    url: a.url,
    status: a.status,
    passed: a.passed,
    // Only analyzeLanding writes this column, so the ids are LandingCheckIds.
    checks: a.checks as LandingAuditView["checks"],
    screenshotAssetIds: a.screenshotAssetIds,
    error: a.error,
    createdAt: a.createdAt.toISOString(),
    finishedAt: a.finishedAt ? a.finishedAt.toISOString() : null,
  };
}

export async function latestLandingAudit(db: DbOrTx, workspaceId: string, productId: string): Promise<LandingAuditView | null> {
  const [a] = await db
    .select()
    .from(landingAudits)
    .where(and(eq(landingAudits.workspaceId, workspaceId), eq(landingAudits.productId, productId)))
    .orderBy(desc(landingAudits.createdAt))
    .limit(1);
  return a ? auditView(a) : null;
}

const TEMPLATE_ORDER = (idx: TemplateIndex) => new Map(idx.template.tasks.map((t, i) => [t.key, i]));

/** The Launch tab (§2.3): the checklist by week, countdown, gates, overdue and the D1–D19 approval count. */
export async function launchView(db: Db, workspaceId: string, productId: string, now = new Date()): Promise<LaunchView | null> {
  const plan = await activeLaunchPlan(db, workspaceId, productId);
  if (!plan) return null;
  const { today, idx, rows, evals } = await evaluatePlan(db, plan, now);
  const titles = new Map(rows.map((r) => [r.key, r.title]));
  const order = TEMPLATE_ORDER(idx);
  const views = rows
    .map((r, i) => taskView(r, evals[i]!, idx, titles))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));

  const groups = new Map<string, LaunchTaskGroup & { order: number }>();
  for (const v of views) {
    const g = weekGroup(v.dayOffset);
    const cur = groups.get(g.label) ?? { label: g.label, fromOffset: g.fromOffset, toOffset: g.toOffset, order: g.order, tasks: [] };
    cur.tasks.push(v);
    groups.set(g.label, cur);
  }

  const t = AUTO_APPROVAL_TARGET;
  const auto = plan.campaignId ? await contentRangeFacts(db, workspaceId, plan.campaignId, t.fromDay, t.toDay) : { total: 0, approved: 0, published: 0 };
  const pct = auto.total ? Math.round((auto.approved / auto.total) * 1000) / 10 : 0;

  return {
    plan: {
      id: plan.id,
      productId: plan.productId,
      campaignId: plan.campaignId,
      startDate: plan.startDate,
      launchDate: plan.launchDate,
      status: plan.status,
      templateVersion: plan.templateVersion,
    },
    countdown: countdown(plan.launchDate, today),
    groups: [...groups.values()].sort((a, b) => a.order - b.order).map(({ order: _o, ...g }) => g),
    gates: gateSummary(plan.id, views),
    overdue: views.filter((v) => v.overdue),
    autoApproval: {
      fromDay: t.fromDay,
      toDay: t.toDay,
      approved: auto.approved,
      total: auto.total,
      pct,
      targetPct: t.targetPct,
      dueDate: addDays(plan.startDate, -t.daysBeforeStart),
      onTrack: auto.total > 0 && pct >= t.targetPct,
    },
    counts: {
      total: views.length,
      done: views.filter((v) => v.status === "done").length,
      skipped: views.filter((v) => v.status === "skipped").length,
      open: views.filter((v) => !TERMINAL.has(v.status)).length,
    },
    latestAudit: await latestLandingAudit(db, workspaceId, productId),
  };
}

/** Gate rows of the product's active plan (B4's publish-time hard gate reads the same rows: passed = status "done"). */
export async function launchGateStatus(db: DbOrTx, workspaceId: string, productId: string): Promise<LaunchGateSummary> {
  const plan = await activeLaunchPlan(db, workspaceId, productId);
  if (!plan) return { planId: null, allPassed: false, gates: [] };
  const rows = await db
    .select()
    .from(launchTasks)
    .where(and(eq(launchTasks.workspaceId, workspaceId), eq(launchTasks.launchPlanId, plan.id), eq(launchTasks.mode, "gate")));
  const gates = rows
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => ({
      key: r.key,
      taskId: r.id,
      title: r.title,
      passed: r.status === "done",
      reasons: r.status === "done" ? [] : r.gate?.reasons.length ? r.gate.reasons : ["Not checked yet."],
      checkedAt: r.gate?.checkedAt ?? null,
    }));
  return { planId: plan.id, allPassed: gates.length > 0 && gates.every((g) => g.passed), gates };
}

function postView(p: typeof posts.$inferSelect): LaunchDayPost {
  return {
    postId: p.id,
    platform: p.platform,
    scheduledAt: p.scheduledAt.toISOString(),
    state: p.state,
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    platformUrl: p.platformUrl,
  };
}

const sumOrNull = (xs: (number | null | undefined)[]) => {
  const vals = xs.filter((x): x is number => typeof x === "number");
  return vals.length ? vals.reduce((s, x) => s + x, 0) : null;
};

/** Posts published on `day` (their latest snapshot) plus the product's own counts for that day. */
export async function launchDayNumbers(db: DbOrTx, workspaceId: string, productId: string, day: string, tz: string): Promise<LaunchDayNumbers> {
  const { from, to } = dayBounds(day, tz);
  const published = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.productId, productId), eq(posts.state, "published"), gte(posts.publishedAt, from), lt(posts.publishedAt, to)));
  const snaps = published.length
    ? await db
        .select({ postId: analyticsSnapshots.postId, metrics: analyticsSnapshots.metrics })
        .from(analyticsSnapshots)
        .where(
          and(
            eq(analyticsSnapshots.workspaceId, workspaceId),
            inArray(
              analyticsSnapshots.postId,
              published.map((p) => p.id),
            ),
          ),
        )
        .orderBy(desc(analyticsSnapshots.ageHours))
    : [];
  const latest = new Map<string, Record<string, number | null>>();
  for (const s of snaps) if (!latest.has(s.postId)) latest.set(s.postId, s.metrics);
  const m = [...latest.values()];
  const conv = await db
    .select({ visits: conversionSnapshots.visits, signups: conversionSnapshots.signups, purchases: conversionSnapshots.purchases })
    .from(conversionSnapshots)
    .where(and(eq(conversionSnapshots.workspaceId, workspaceId), eq(conversionSnapshots.productId, productId), eq(conversionSnapshots.day, day)));
  return {
    day,
    postsPublished: published.length,
    views: sumOrNull(m.map((x) => x.views)),
    comments: sumOrNull(m.map((x) => x.comments)),
    linkClicks: sumOrNull(m.map((x) => x.linkClicks)),
    visits: sumOrNull(conv.map((c) => c.visits)),
    signups: sumOrNull(conv.map((c) => c.signups)),
    purchases: sumOrNull(conv.map((c) => c.purchases)),
  };
}

const UPCOMING_POST_STATES = ["approved", "queued", "preparing", "submitting", "submitted", "unknown", "awaiting_user"] as const;

/** Launch-day screen (§2.3): today's tasks, posts still to go out today, live posts with comment links, numbers. */
export async function launchDayView(db: Db, workspaceId: string, productId: string, now = new Date()): Promise<LaunchDayView | null> {
  const plan = await activeLaunchPlan(db, workspaceId, productId);
  if (!plan) return null;
  const { tz, today, idx, rows, evals } = await evaluatePlan(db, plan, now);
  const titles = new Map(rows.map((r) => [r.key, r.title]));
  const order = TEMPLATE_ORDER(idx);
  const views = rows.map((r, i) => taskView(r, evals[i]!, idx, titles));
  const todayTasks = views
    .filter((v) => v.dueDate === today || (v.overdue && !TERMINAL.has(v.status)))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
  const { from, to } = dayBounds(today, tz);
  const todays = await db
    .select()
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.productId, productId), gte(posts.scheduledAt, from), lt(posts.scheduledAt, to)))
    .orderBy(posts.scheduledAt);
  const publishedToday = await db
    .select()
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.productId, productId), eq(posts.state, "published"), gte(posts.publishedAt, from), lt(posts.publishedAt, to)))
    .orderBy(posts.publishedAt);
  const [kit] = await db
    .select({ id: launchKits.id, status: launchKits.status })
    .from(launchKits)
    .where(and(eq(launchKits.workspaceId, workspaceId), eq(launchKits.launchPlanId, plan.id), eq(launchKits.kind, "reply_bank")));
  return {
    planId: plan.id,
    countdown: countdown(plan.launchDate, today),
    todayTasks,
    gates: gateSummary(plan.id, views),
    nextPostsToday: todays.filter((p) => (UPCOMING_POST_STATES as readonly string[]).includes(p.state)).map(postView),
    publishedToday: publishedToday.map(postView),
    replyBank: kit ? { kitId: kit.id, status: kit.status } : null,
    yesterday: await launchDayNumbers(db, workspaceId, productId, addDays(today, -1), tz),
    today: await launchDayNumbers(db, workspaceId, productId, today, tz),
  };
}

// ── UI actions ──

async function loadTask(db: DbOrTx, workspaceId: string, taskId: string) {
  const [row] = await db
    .select({ task: launchTasks, plan: launchPlans })
    .from(launchTasks)
    .innerJoin(launchPlans, eq(launchPlans.id, launchTasks.launchPlanId))
    .where(and(eq(launchTasks.id, taskId), eq(launchTasks.workspaceId, workspaceId)));
  if (!row) throw new LaunchPlanError("Task not found.", "not_found");
  return row;
}

/**
 * Tick, skip or reopen a checklist task (UI session). Gates only pass by their checks, so they
 * refuse every hand change; a task that waits on a gate can't be ticked until the gate passes.
 */
export async function setTaskStatus(
  db: Db,
  workspaceId: string,
  taskId: string,
  status: "done" | "skipped" | "todo",
  userId: string,
  now = new Date(),
): Promise<LaunchTaskStatus> {
  return db.transaction(async (tx) => {
    const { task, plan } = await loadTask(tx, workspaceId, taskId);
    if (task.mode === "gate") {
      throw new LaunchPlanError("This one passes on its own once its check passes. Run the check again after fixing the problem.", "gate_manual");
    }
    if (status === "done" && task.mode === "auto") {
      throw new LaunchPlanError("The app ticks this one itself once the work behind it is done.", "auto_manual");
    }
    if (status === "done") {
      const gates = task.dependsOn.length
        ? await tx
            .select({ title: launchTasks.title, status: launchTasks.status })
            .from(launchTasks)
            .where(and(eq(launchTasks.launchPlanId, plan.id), eq(launchTasks.mode, "gate"), inArray(launchTasks.key, task.dependsOn)))
        : [];
      const open = gates.filter((g) => g.status !== "done");
      if (open.length) throw new LaunchPlanError(`Waiting on the checks: ${open.map((g) => g.title).join(", ")}.`, "blocked");
    }
    await tx
      .update(launchTasks)
      .set({ status, ...(status === "done" ? { doneAt: now, doneBy: userId } : { doneAt: null, doneBy: null }) })
      .where(eq(launchTasks.id, task.id));
    await audit(tx, workspaceId, { type: "user", id: userId }, "launch.task.status", `launch_task:${task.id}`, { key: task.key, from: task.status, to: status });
    await refreshLaunchPlan(tx, workspaceId, plan.id, now);
    const [after] = await tx.select({ status: launchTasks.status }).from(launchTasks).where(eq(launchTasks.id, task.id));
    return after!.status;
  });
}

/** Turn an optional task (BetaList, Uneed, PH, ads kit) on or off (open question 4: off by default). */
export async function toggleOptionalTask(db: Db, workspaceId: string, taskId: string, on: boolean, userId: string, now = new Date()): Promise<LaunchTaskStatus> {
  return db.transaction(async (tx) => {
    const { task, plan } = await loadTask(tx, workspaceId, taskId);
    const tpl = launchTemplate(plan.templateVersion).tasks.find((t) => t.key === task.key);
    if (!tpl?.optional) throw new LaunchPlanError("This task is part of every launch and can't be turned off.", "not_optional");
    const next: LaunchTaskStatus | null = on ? (task.status === "skipped" ? "todo" : null) : task.status === "done" ? null : "skipped";
    if (next) {
      await tx.update(launchTasks).set({ status: next, doneAt: null, doneBy: null }).where(eq(launchTasks.id, task.id));
      await audit(tx, workspaceId, { type: "user", id: userId }, on ? "launch.task.optional_on" : "launch.task.optional_off", `launch_task:${task.id}`, { key: task.key });
      await refreshLaunchPlan(tx, workspaceId, plan.id, now);
    }
    const [after] = await tx.select({ status: launchTasks.status }).from(launchTasks).where(eq(launchTasks.id, task.id));
    return after!.status;
  });
}

export { gateRow as launchGateRow };
