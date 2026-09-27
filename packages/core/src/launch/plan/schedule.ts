import type { LaunchGateResult, LaunchRefHint, LaunchTaskMode, LaunchTaskStatus, LaunchTemplate, LaunchTemplateTask } from "@mkt/contracts";
import { localDay } from "../../publishing/time.ts";
import { addDays } from "../../publishing/zoned.ts";

// Pure scheduler + evaluator for the D30 checklist (§4.3 launch_tasks: todo → ready → scheduled →
// done | skipped; gates block the tasks that depend on them). No I/O here; plan.ts does the DB.

export class LaunchPlanError extends Error {
  constructor(
    message: string,
    readonly code: "bad_template" | "bad_dates" | "not_found" | "gate_manual" | "auto_manual" | "blocked" | "not_optional" | "no_website" | "bad_url" = "bad_template",
  ) {
    super(message);
    this.name = "LaunchPlanError";
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TERMINAL: ReadonlySet<LaunchTaskStatus> = new Set(["done", "skipped"]);

/** Whole days from `a` to `b` (b − a), both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Dependency order; throws on duplicate keys, unknown dependencies and cycles. */
export function topoOrder<T extends { key: string; dependsOn: readonly string[] }>(tasks: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const task of tasks) {
    if (byKey.has(task.key)) throw new LaunchPlanError(`The launch checklist has "${task.key}" twice.`);
    byKey.set(task.key, task);
  }
  for (const task of tasks) {
    for (const d of task.dependsOn) {
      if (!byKey.has(d)) throw new LaunchPlanError(`"${task.key}" waits on "${d}", which isn't in the checklist.`);
      if (d === task.key) throw new LaunchPlanError(`"${task.key}" waits on itself.`);
    }
  }
  const out: T[] = [];
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = placed
  const visit = (task: T, path: string[]) => {
    const s = state.get(task.key);
    if (s === 2) return;
    if (s === 1) throw new LaunchPlanError(`The launch checklist has a loop: ${[...path, task.key].join(" → ")}.`);
    state.set(task.key, 1);
    for (const d of task.dependsOn) visit(byKey.get(d)!, [...path, task.key]);
    state.set(task.key, 2);
    out.push(task);
  };
  for (const task of tasks) visit(task, []);
  return out;
}

export function validateTemplate(template: LaunchTemplate): void {
  topoOrder(template.tasks);
}

/** A template task's launch-relative offset (anchor "start" is shifted by D1's distance from launch). */
function launchRelative(offset: number, anchor: LaunchTemplateTask["anchor"], startToLaunch: number): number {
  return anchor === "start" ? offset - startToLaunch : offset;
}

export interface BuildLaunchInput {
  launchDate: string;
  startDate: string;
  /** Workspace IANA zone: "today" is its local day. */
  timeZone: string;
  today: Date | string;
  optionalOn?: ReadonlySet<string>;
}

export interface BuiltLaunchTask {
  key: string;
  title: string;
  detail: string;
  mode: LaunchTaskMode;
  /** Launch-relative (what launch_tasks.day_offset stores). */
  dayOffset: number;
  dueDate: string;
  opensOn: string | null;
  dependsOn: string[];
  optional: boolean;
  status: LaunchTaskStatus;
  refHint: LaunchRefHint;
  /** Due before the plan existed: flagged in the view's overdue list, never dropped. */
  overdueAtCreation: boolean;
}

export function toLocalDay(today: Date | string, timeZone: string): string {
  if (typeof today === "string") {
    if (!DAY_RE.test(today)) throw new LaunchPlanError("Today must be a YYYY-MM-DD date.", "bad_dates");
    return today;
  }
  return localDay(today, timeZone);
}

/** Dates every task of `template` against the launch day. Throws on a bad template or dates. */
export function buildLaunchTasks(template: LaunchTemplate, input: BuildLaunchInput): BuiltLaunchTask[] {
  if (!DAY_RE.test(input.launchDate) || !DAY_RE.test(input.startDate)) {
    throw new LaunchPlanError("The launch day and the first day must be dates.", "bad_dates");
  }
  const startToLaunch = daysBetween(input.startDate, input.launchDate);
  if (startToLaunch < 0) throw new LaunchPlanError("The launch day can't be before the campaign starts.", "bad_dates");
  const today = toLocalDay(input.today, input.timeZone);
  const ordered = topoOrder(template.tasks);
  const optionalOn = input.optionalOn ?? new Set<string>();
  return ordered.map((task) => {
    const dayOffset = launchRelative(task.dayOffset, task.anchor, startToLaunch);
    const opens = task.opensOffset === undefined ? null : launchRelative(task.opensOffset, task.anchor, startToLaunch);
    const dueDate = addDays(input.launchDate, dayOffset);
    const status: LaunchTaskStatus = task.optional && !optionalOn.has(task.key) ? "skipped" : "todo";
    return {
      key: task.key,
      title: task.title,
      detail: task.detail,
      mode: task.mode,
      dayOffset,
      dueDate,
      opensOn: opens === null ? null : addDays(input.launchDate, opens),
      dependsOn: [...task.dependsOn],
      optional: task.optional,
      status,
      refHint: task.ref,
      overdueAtCreation: status !== "skipped" && dueDate < today,
    };
  });
}

/** The row's ref seed: the template hint as strings (launch_tasks.ref is Record<string, string>). */
export function refFromHint(hint: LaunchRefHint, extra: Record<string, string> = {}): Record<string, string> {
  const ref: Record<string, string> = { kind: hint.kind };
  if (hint.kitKind) ref.kitKind = hint.kitKind;
  if (hint.fromDay !== undefined) ref.fromDay = String(hint.fromDay);
  if (hint.toDay !== undefined) ref.toDay = String(hint.toDay);
  return { ...ref, ...extra };
}

// ── evaluator ──

export interface EvalTask {
  key: string;
  title: string;
  mode: LaunchTaskMode;
  dueDate: string;
  opensOn: string | null;
  dependsOn: readonly string[];
  status: LaunchTaskStatus;
  gate: LaunchGateResult | null;
  refHint: LaunchRefHint;
}

export interface ContentRangeFacts {
  /** Planned items in the day range (skipped items don't count). */
  total: number;
  /** Items whose posts are all approved (queued or later). */
  approved: number;
  /** Items whose posts are all published. */
  published: number;
}

export type KitFactStatus = "planned" | "generating" | "ready" | "needs_you" | "failed";

export interface LaunchFacts {
  /** Keyed by task key. */
  contentRanges?: Record<string, ContentRangeFacts>;
  kits?: Partial<Record<string, { id: string; status: KitFactStatus; needsYouReason?: string | null }>>;
  broadcast?: { id: string; status: string; hasBody: boolean } | null;
}

export interface TaskEvaluation {
  key: string;
  status: LaunchTaskStatus;
  reasons: string[];
  /** Keys of unfinished dependencies. */
  blockedBy: string[];
  overdue: boolean;
  /** Ids to merge into the row's ref (kitId, broadcastId). */
  refPatch?: Record<string, string>;
}

const APPROVED_BROADCAST = new Set(["approved", "scheduled_at_resend", "sent"]);

/** Tasks whose status the app works out (the person can't tick them). */
export function isDerived(task: Pick<EvalTask, "mode" | "refHint">): boolean {
  return task.mode === "gate" || task.mode === "auto" || task.refHint.kind === "broadcast_approve";
}

/**
 * Next status of every task. Tasks are walked in dependency order, so a gate that stops passing
 * sends its dependents back to "todo" in the same pass.
 * - gate: "done" iff gate.passed (never skipped, never ticked by hand);
 * - done/skipped stay (except gates);
 * - auto tasks follow the facts (content approved → scheduled, published → done; kit ready → done;
 *   email written/approved/sent);
 * - otherwise todo → ready once every dependency is done or skipped and the task's window is open.
 */
export function evaluateTasks(tasks: readonly EvalTask[], facts: LaunchFacts, today: string): TaskEvaluation[] {
  const ordered = topoOrder(tasks);
  const next = new Map<string, LaunchTaskStatus>();
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out = new Map<string, TaskEvaluation>();

  for (const task of ordered) {
    const blockedBy = task.dependsOn.filter((d) => !TERMINAL.has(next.get(d)!));
    const open = !task.opensOn || today >= task.opensOn;
    const base: LaunchTaskStatus = blockedBy.length === 0 && open ? "ready" : "todo";
    const reasons: string[] = [];
    let status: LaunchTaskStatus;
    let refPatch: Record<string, string> | undefined;

    if (task.mode === "gate") {
      status = task.gate?.passed ? "done" : base;
      if (!task.gate?.passed) reasons.push(...(task.gate?.reasons.length ? task.gate.reasons : ["Not checked yet."]));
    } else if (TERMINAL.has(task.status)) {
      status = task.status;
    } else {
      status = base;
      const r = task.refHint;
      if (r.kind === "content_range") {
        const f = facts.contentRanges?.[task.key];
        if (!f || f.total === 0) reasons.push("No posts planned for these days yet.");
        else if (f.published >= f.total) status = "done";
        else if (f.approved >= f.total) status = "scheduled";
        else reasons.push(`${f.approved} of ${f.total} approved.`);
      } else if (r.kind === "kit" && r.kitKind) {
        const k = facts.kits?.[r.kitKind];
        if (k) refPatch = { kitId: k.id };
        if (k?.status === "ready") status = "done";
        else if (k?.status === "generating") status = "scheduled";
        else if (k?.status === "needs_you") reasons.push(k.needsYouReason || "The kit needs you before it can be used.");
        else if (k?.status === "failed") reasons.push("Making the kit failed. Try again.");
      } else if (r.kind === "broadcast_write" || r.kind === "broadcast_approve" || r.kind === "broadcast_send") {
        const b = facts.broadcast;
        if (b) refPatch = { broadcastId: b.id };
        if (r.kind === "broadcast_write" && b?.hasBody && b.status !== "canceled" && b.status !== "failed") status = "done";
        if (r.kind === "broadcast_approve" && b && APPROVED_BROADCAST.has(b.status)) status = "done";
        if (r.kind === "broadcast_send") {
          if (b?.status === "sent") status = "done";
          else if (b?.status === "scheduled_at_resend") status = "scheduled";
          else if (b?.status === "failed") reasons.push("The email didn't send. Open it to see why.");
        }
      }
    }

    if (status === "todo" && blockedBy.length) {
      reasons.unshift(`Waiting on: ${blockedBy.map((d) => byKey.get(d)?.title ?? d).join(", ")}.`);
    } else if (status === "todo" && !open && task.opensOn) {
      reasons.unshift(`Starts ${task.opensOn}.`);
    }
    next.set(task.key, status);
    out.set(task.key, {
      key: task.key,
      status,
      reasons,
      blockedBy,
      overdue: !TERMINAL.has(status) && status !== "scheduled" && task.dueDate < today,
      ...(refPatch ? { refPatch } : {}),
    });
  }
  return tasks.map((t) => out.get(t.key)!);
}

// ── labels ──

export function dayLabel(offset: number): string {
  if (offset === 0) return "Launch day";
  const n = Math.abs(offset);
  return `${n} day${n === 1 ? "" : "s"} ${offset < 0 ? "before" : "after"} launch`;
}

/** Week buckets relative to launch: "N weeks before", "Launch day", "Launch week", "N weeks after". */
export function weekGroup(offset: number): { label: string; fromOffset: number; toOffset: number; order: number } {
  if (offset === 0) return { label: "Launch day", fromOffset: 0, toOffset: 0, order: 0 };
  if (offset < 0) {
    const n = Math.ceil(-offset / 7);
    return { label: `${n} week${n === 1 ? "" : "s"} before`, fromOffset: -7 * n, toOffset: -7 * (n - 1) - 1, order: -n };
  }
  if (offset < 7) return { label: "Launch week", fromOffset: 1, toOffset: 6, order: 0.5 };
  const n = Math.floor(offset / 7);
  return { label: `${n} week${n === 1 ? "" : "s"} after`, fromOffset: 7 * n, toOffset: 7 * n + 6, order: n };
}
