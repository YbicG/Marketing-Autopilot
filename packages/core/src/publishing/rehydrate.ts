import { and, eq, gte, inArray } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { ensureAnalyticsWindows, WINDOWS } from "../analytics/windows.ts";
import type { AnalyticsGateway, AnalyticsWindowName, JobGateway } from "./scheduler.ts";
import { isLate, type Effect, type PostEvent, type TransitionCtx } from "./state-machine.ts";
import { applyEvents, loadPost, PostConflict, type Actor, type PostRow } from "./store.ts";

const { analyticsSnapshots, posts } = schema;
const WORKER: Actor = { type: "worker" };

/** A post stuck mid-step this long was interrupted by a restart, not still being worked on. */
export const INTERRUPTED_AFTER_MIN = 10;

export interface RehydrateDeps {
  db: Db;
  gateway: JobGateway;
  analytics?: AnalyticsGateway;
  graceMin: number;
  now?: () => Date;
  /** Boot runs across every workspace; tests and a per-workspace repair can narrow it. */
  workspaceId?: string;
}

export interface RehydrateSummary {
  ensured: number;
  created: number;
  missed: number;
  interrupted: number;
  unknown: number;
  analyticsCreated: number;
}

/**
 * boot.rehydrate (§3.3, D2): on every worker start, rebuild from Postgres what Redis should hold.
 * - approved → queued, queued → its delayed publish.due exists (same jobId, so it never duplicates)
 * - a slot more than MISSED_SLOT_GRACE_MIN in the past → missed (never posts late)
 * - preparing left behind by a restart → queued again (nothing was sent)
 * - submitting left behind → unknown (something may have been sent: lookup decides)
 * - published in the last 8 days → its analytics windows exist
 */
export async function rehydrate(deps: RehydrateDeps): Promise<RehydrateSummary> {
  const now = deps.now?.() ?? new Date();
  const ctx: TransitionCtx = { now, graceMin: deps.graceMin };
  const sum: RehydrateSummary = { ensured: 0, created: 0, missed: 0, interrupted: 0, unknown: 0, analyticsCreated: 0 };
  const cutoff = new Date(now.getTime() - INTERRUPTED_AFTER_MIN * 60_000);

  const rows = await deps.db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        inArray(posts.state, ["approved", "queued", "preparing", "submitting"]),
        ...(deps.workspaceId ? [eq(posts.workspaceId, deps.workspaceId)] : []),
      ),
    );

  for (const { id } of rows) {
    const post = await loadPost(deps.db, null, id);
    if (!post) continue;
    const events = eventsFor(post, ctx, cutoff);
    try {
      let effects: Effect[] = [];
      let after = post;
      if (events.length) {
        const r = await deps.db.transaction((tx) => applyEvents(tx, post, events, ctx, WORKER, { rehydrate: true }));
        effects = r.effects;
        after = r.post;
      }
      if (after.state === "missed") sum.missed++;
      if (post.state === "preparing" && after.state === "queued") sum.interrupted++;
      if (after.state === "unknown") sum.unknown++;
      if (after.state === "queued") {
        sum.ensured++;
        const res = await deps.gateway.ensure({
          jobId: after.idempotencyKey,
          postId: after.id,
          generation: after.generation,
          runAt: new Date(Math.max(after.scheduledAt.getTime(), now.getTime())),
        });
        if (res === "created") sum.created++;
      }
      // Only removals matter here; adds went through ensure above.
      for (const e of effects) if (e.type === "removeDelayedJob") await deps.gateway.remove(e.jobId);
    } catch (err) {
      if (!(err instanceof PostConflict)) throw err;
    }
  }

  if (deps.analytics) {
    const since = new Date(now.getTime() - 8 * 86_400_000);
    const published = await deps.db
      .select({ id: posts.id, publishedAt: posts.publishedAt })
      .from(posts)
      .where(
        and(
          eq(posts.state, "published"),
          gte(posts.publishedAt, since),
          ...(deps.workspaceId ? [eq(posts.workspaceId, deps.workspaceId)] : []),
        ),
      );
    const ids = published.map((p) => p.id);
    const taken = ids.length
      ? await deps.db
          .select({ postId: analyticsSnapshots.postId, window: analyticsSnapshots.window })
          .from(analyticsSnapshots)
          .where(and(inArray(analyticsSnapshots.postId, ids), eq(analyticsSnapshots.mature, true)))
      : [];
    for (const p of published) {
      if (!p.publishedAt) continue;
      const skip = taken.filter((t) => t.postId === p.id).map((t) => t.window as AnalyticsWindowName);
      if (skip.length === WINDOWS.length) continue;
      sum.analyticsCreated += await ensureAnalyticsWindows(deps.analytics, p.id, p.publishedAt, skip);
    }
  }
  return sum;
}

function eventsFor(post: PostRow, ctx: TransitionCtx, cutoff: Date): PostEvent[] {
  const late = isLate(post.scheduledAt, ctx);
  switch (post.state) {
    case "approved":
      return late ? [{ type: "enqueue" }, { type: "due" }] : [{ type: "enqueue" }];
    case "queued":
      return late ? [{ type: "due" }] : [];
    case "preparing":
      return post.updatedAt < cutoff ? [{ type: "prepare_interrupted" }, ...(late ? [{ type: "due" } as const] : [])] : [];
    case "submitting":
      return post.updatedAt < cutoff ? [{ type: "no_response", reason: "The worker restarted during the upload." }] : [];
    default:
      return [];
  }
}

