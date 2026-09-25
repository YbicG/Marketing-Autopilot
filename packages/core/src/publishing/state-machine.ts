import type { PostEventName, PostState } from "@mkt/contracts";

/**
 * The post state machine (§4.3), pure. `transition` never touches the DB or queues: it returns the
 * row patch and the effects, and store.ts applies both in the transaction that writes post_events.
 *
 *   draft → pending_approval --approve--> approved --enqueue--> queued
 *   queued --due--> preparing → submitting --accepted--> submitted --published--> published | --failed--> failed
 *   submitting --timeout/5xx, no response--> unknown --lookup found--> submitted | absent--> approved (generation++)
 *   submitted --TikTok drafts mode--> awaiting_user --user marks done--> published
 *   queued --due > MISSED_SLOT_GRACE_MIN late--> missed --post now | reschedule--> approved
 *   approved|queued --edit or approval voided--> pending_approval (delayed job removed)
 *   approved|queued --pause--> paused (job removed) --resume--> approved (past slots → missed)
 *   approved|queued --stale--> pending_approval
 *   any state before submitting --cancel--> canceled
 *
 * Additions beyond the diagram, each needed so no post can get stuck:
 * - preparing --prepare_invalid (hash mismatch, claim gone)--> pending_approval; --prepare_blocked--> failed;
 *   --prepare_interrupted (worker died mid-prepare, nothing was sent)--> queued.
 * - submitting --published|failed|drafts_mode--> when the upload call itself answers that way.
 * - still_pending keeps submitted/unknown where they are and schedules the next poll.
 * - edit/void also apply to paused and missed (and edit to failed), so a changed post always needs a new approval.
 * - posted_manually ("Download & post yourself") from any state where nothing was sent.
 */

export const MAX_GENERATIONS = 3;
/** Reconcile backoff (§5.8 step 4), in minutes; the last step repeats. */
export const RECONCILE_BACKOFF_MIN = [1, 2, 5, 10, 30] as const;

export function idempotencyKey(postId: string, generation: number): string {
  return `pst_${postId}_g${generation}`;
}

export function reconcileDelayMin(attempt: number): number {
  return RECONCILE_BACKOFF_MIN[Math.min(Math.max(attempt, 0), RECONCILE_BACKOFF_MIN.length - 1)]!;
}

export interface PostSnapshot {
  id: string;
  state: PostState;
  generation: number;
  scheduledAt: Date;
  approvalId: string | null;
}

export type PostEvent =
  | { type: "submit_for_approval" }
  | { type: "approve"; approvalId: string }
  | { type: "enqueue" }
  | { type: "due" }
  | { type: "prepared" }
  | { type: "prepare_invalid"; reason: string }
  | { type: "prepare_blocked"; reason: string }
  | { type: "prepare_interrupted" }
  | { type: "accepted"; requestId?: string }
  | { type: "published"; url?: string; providerPostId?: string; requestId?: string }
  | { type: "failed"; reason: string }
  | { type: "no_response"; reason: string }
  | { type: "still_pending"; attempt: number }
  | { type: "lookup_found"; requestId?: string }
  | { type: "lookup_absent" }
  | { type: "drafts_mode"; reason?: string }
  | { type: "user_done"; url?: string }
  | { type: "post_now" }
  | { type: "reschedule"; at: Date }
  | { type: "edit" }
  | { type: "void_approval"; reason: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stale"; reason: string }
  | { type: "cancel" }
  | { type: "posted_manually"; url: string };

// Compile-time check that the contract's event names and this union agree.
type _EventsMatch = [PostEvent["type"]] extends [PostEventName]
  ? [PostEventName] extends [PostEvent["type"]]
    ? true
    : never
  : never;
export const _eventsMatch: _EventsMatch = true;

export interface TransitionCtx {
  now: Date;
  /** MISSED_SLOT_GRACE_MIN (D3, default 120). */
  graceMin: number;
}

export type NeedsYouKind = "missed" | "failed" | "manual_finish" | "needs_approval";

export type Effect =
  | { type: "addDelayedJob"; jobId: string; postId: string; generation: number; runAt: Date }
  | { type: "removeDelayedJob"; jobId: string }
  | { type: "submit" }
  | { type: "lookup"; at: Date }
  | { type: "voidApproval"; approvalId: string; reason: string }
  | { type: "notify"; kind: NeedsYouKind; reason: string }
  | { type: "scheduleAnalytics"; publishedAt: Date };

export interface PostPatch {
  state?: PostState;
  generation?: number;
  idempotencyKey?: string;
  approvalId?: string | null;
  scheduledAt?: Date;
  lastError?: string | null;
  staleReason?: string | null;
  nextReconcileAt?: Date | null;
  missedAt?: Date | null;
  publishedAt?: Date | null;
  platformUrl?: string;
  providerRequestId?: string;
  providerPostId?: string;
}

export type TransitionResult =
  | { ok: true; from: PostState; to: PostState; patch: PostPatch & { state: PostState }; effects: Effect[] }
  | { ok: false; from: PostState; event: PostEvent["type"]; error: string };

const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

export const BEFORE_SUBMITTING: readonly PostState[] = [
  "draft",
  "pending_approval",
  "approved",
  "queued",
  "preparing",
  "missed",
  "paused",
];

/** Posts that hold a delayed publish.due job. */
export const JOB_HOLDING_STATES: readonly PostState[] = ["queued"];

export function isLate(scheduledAt: Date, ctx: TransitionCtx): boolean {
  return ctx.now.getTime() - scheduledAt.getTime() > ctx.graceMin * 60_000;
}

export function transition(post: PostSnapshot, event: PostEvent, ctx: TransitionCtx): TransitionResult {
  const from = post.state;
  const jobId = idempotencyKey(post.id, post.generation);
  const ok = (to: PostState, effects: Effect[] = [], patch: PostPatch = {}): TransitionResult => ({
    ok: true,
    from,
    to,
    patch: { ...patch, state: to },
    effects,
  });
  const illegal = (why?: string): TransitionResult => ({
    ok: false,
    from,
    event: event.type,
    error: why ?? `A post that is ${from.replace("_", " ")} can't ${event.type.replaceAll("_", " ")}`,
  });
  const removeJob: Effect = { type: "removeDelayedJob", jobId };
  const voidIt = (reason: string): Effect[] =>
    post.approvalId ? [{ type: "voidApproval", approvalId: post.approvalId, reason }] : [];
  const backToApproval = (reason: string, stale: string | null): TransitionResult =>
    ok("pending_approval", [removeJob, ...voidIt(reason), { type: "notify", kind: "needs_approval", reason }], {
      approvalId: null,
      staleReason: stale,
    });
  const missed = (): TransitionResult =>
    ok(
      "missed",
      [removeJob, { type: "notify", kind: "missed", reason: "The server was down at posting time. Post now or pick a new time." }],
      { missedAt: ctx.now },
    );
  const published = (url?: string, providerPostId?: string, requestId?: string): TransitionResult =>
    ok("published", [{ type: "scheduleAnalytics", publishedAt: ctx.now }], {
      publishedAt: ctx.now,
      nextReconcileAt: null,
      lastError: null,
      ...(url ? { platformUrl: url } : {}),
      ...(providerPostId ? { providerPostId } : {}),
      ...(requestId ? { providerRequestId: requestId } : {}),
    });
  const failed = (reason: string): TransitionResult =>
    ok("failed", [{ type: "notify", kind: "failed", reason }], { lastError: reason, nextReconcileAt: null });

  // Shared rules first.
  if (event.type === "cancel") {
    return BEFORE_SUBMITTING.includes(from) ? ok("canceled", [removeJob], { nextReconcileAt: null }) : illegal();
  }
  if (event.type === "posted_manually") {
    return ["pending_approval", "approved", "queued", "missed", "paused", "failed"].includes(from)
      ? ok("published", [removeJob, { type: "scheduleAnalytics", publishedAt: ctx.now }], {
          publishedAt: ctx.now,
          platformUrl: event.url,
          lastError: null,
        })
      : illegal();
  }

  switch (from) {
    case "draft":
      if (event.type === "submit_for_approval") return ok("pending_approval");
      if (event.type === "edit") return ok("draft");
      return illegal();

    case "pending_approval":
      if (event.type === "approve") return ok("approved", [], { approvalId: event.approvalId, staleReason: null, lastError: null });
      if (event.type === "edit") return ok("pending_approval");
      return illegal();

    case "approved":
    case "queued":
      if (event.type === "enqueue") {
        const runAt = new Date(Math.max(post.scheduledAt.getTime(), ctx.now.getTime()));
        return ok("queued", [{ type: "addDelayedJob", jobId, postId: post.id, generation: post.generation, runAt }]);
      }
      if (event.type === "due") {
        if (from !== "queued") return illegal();
        return isLate(post.scheduledAt, ctx) ? missed() : ok("preparing");
      }
      if (event.type === "edit") return backToApproval("Edited after approval", null);
      if (event.type === "void_approval") return backToApproval(event.reason, null);
      if (event.type === "stale") return backToApproval(event.reason, event.reason);
      if (event.type === "pause") return ok("paused", [removeJob]);
      return illegal();

    case "preparing":
      if (event.type === "prepared") return ok("submitting", [{ type: "submit" }]);
      if (event.type === "prepare_invalid") return backToApproval(event.reason, event.reason);
      if (event.type === "prepare_blocked") return failed(event.reason);
      if (event.type === "prepare_interrupted") {
        return ok("queued", [{ type: "addDelayedJob", jobId, postId: post.id, generation: post.generation, runAt: ctx.now }]);
      }
      return illegal();

    case "submitting":
      if (event.type === "accepted") {
        return ok("submitted", [], {
          nextReconcileAt: minutes(ctx.now, reconcileDelayMin(0)),
          ...(event.requestId ? { providerRequestId: event.requestId } : {}),
        });
      }
      if (event.type === "published") return published(event.url, event.providerPostId, event.requestId);
      if (event.type === "failed") return failed(event.reason);
      if (event.type === "no_response") {
        const at = minutes(ctx.now, reconcileDelayMin(0));
        return ok("unknown", [{ type: "lookup", at }], { nextReconcileAt: at, lastError: event.reason });
      }
      if (event.type === "drafts_mode") {
        return ok(
          "awaiting_user",
          [{ type: "notify", kind: "manual_finish", reason: event.reason ?? "Finish this post in the TikTok app." }],
          { nextReconcileAt: null },
        );
      }
      return illegal();

    case "submitted":
      if (event.type === "published") return published(event.url, event.providerPostId, event.requestId);
      if (event.type === "failed") return failed(event.reason);
      if (event.type === "still_pending") {
        return ok("submitted", [], { nextReconcileAt: minutes(ctx.now, reconcileDelayMin(event.attempt)) });
      }
      if (event.type === "drafts_mode") {
        return ok(
          "awaiting_user",
          [{ type: "notify", kind: "manual_finish", reason: event.reason ?? "Finish this post in the TikTok app." }],
          { nextReconcileAt: null },
        );
      }
      return illegal();

    case "unknown":
      if (event.type === "lookup_found") {
        return ok("submitted", [], {
          nextReconcileAt: minutes(ctx.now, reconcileDelayMin(0)),
          ...(event.requestId ? { providerRequestId: event.requestId } : {}),
        });
      }
      if (event.type === "lookup_absent") {
        if (post.generation >= MAX_GENERATIONS) {
          return failed("We tried 3 times and couldn't confirm this post went out. Check the account, then post it yourself or reschedule.");
        }
        const generation = post.generation + 1;
        return ok("approved", [], {
          generation,
          idempotencyKey: idempotencyKey(post.id, generation),
          nextReconcileAt: null,
        });
      }
      if (event.type === "still_pending") {
        const at = minutes(ctx.now, reconcileDelayMin(event.attempt));
        return ok("unknown", [{ type: "lookup", at }], { nextReconcileAt: at });
      }
      return illegal();

    case "awaiting_user":
      if (event.type === "user_done") return published(event.url);
      if (event.type === "published") return published(event.url, event.providerPostId, event.requestId);
      return illegal();

    case "missed":
      if (event.type === "post_now") return ok("approved", [], { scheduledAt: ctx.now, missedAt: null });
      if (event.type === "reschedule") {
        if (event.at.getTime() <= ctx.now.getTime()) return illegal("Pick a time in the future.");
        return ok("approved", [], { scheduledAt: event.at, missedAt: null });
      }
      if (event.type === "edit") return backToApproval("Edited after approval", null);
      if (event.type === "void_approval") return backToApproval(event.reason, null);
      return illegal();

    case "paused":
      if (event.type === "resume") return isLate(post.scheduledAt, ctx) ? missed() : ok("approved");
      if (event.type === "edit") return backToApproval("Edited after approval", null);
      if (event.type === "void_approval") return backToApproval(event.reason, null);
      if (event.type === "stale") return backToApproval(event.reason, event.reason);
      return illegal();

    case "failed":
      if (event.type === "edit") return ok("pending_approval", voidIt("Edited after it failed"), { approvalId: null });
      return illegal();

    case "published":
    case "canceled":
      return illegal(`This post is already ${from}.`);
  }
}
