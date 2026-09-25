import { and, asc, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schema } from "@mkt/db";
import { publisher, type PublishStatus } from "@mkt/providers";
import { commitEvents, ctxOf, type PublishDeps } from "./due.ts";
import type { PostEvent } from "./state-machine.ts";
import { loadPost, PostConflict, type Actor, type PostRow } from "./store.ts";

const { postEvents, posts, socialConnections } = schema;
const WORKER: Actor = { type: "worker" };

/** A submitted post that still isn't confirmed after this long goes to Needs you instead of polling forever. */
export const SUBMITTED_GIVE_UP_HOURS = 48;

async function attempts(deps: PublishDeps, post: PostRow): Promise<number> {
  const [row] = await deps.db
    .select({ n: count() })
    .from(postEvents)
    .where(
      and(
        eq(postEvents.postId, post.id),
        eq(postEvents.event, "still_pending"),
        sql`${postEvents.data}->>'generation' = ${String(post.generation)}`,
      ),
    );
  return (row?.n ?? 0) + 1;
}

/** Events for a status answer about a post we know reached the publisher. */
export function statusEvents(status: PublishStatus, attempt: number): PostEvent[] {
  switch (status.state) {
    case "published":
      return [{ type: "published", url: status.url, providerPostId: status.postId, requestId: status.requestId }];
    case "failed":
      return status.retryable ? [{ type: "still_pending", attempt }] : [{ type: "failed", reason: status.reason }];
    case "awaiting_user":
      return [{ type: "drafts_mode", reason: status.reason }];
    case "accepted":
    case "pending":
      return [{ type: "still_pending", attempt }];
  }
}

export interface ReconcileSummary {
  checked: number;
  changed: { postId: string; from: string; to: string }[];
}

/**
 * publish.reconcile (repeating every 5 min while anything is submitted/unknown; §3.3). Each post
 * is polled on its own backoff (1, 2, 5, 10, 30 min…) via next_reconcile_at. `unknown` posts are
 * only ever looked up by external_id; "absent" is the one answer that re-queues them (generation+1, max 3).
 */
export async function reconcilePosts(deps: PublishDeps, opts: { limit?: number; workspaceId?: string } = {}): Promise<ReconcileSummary> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        inArray(posts.state, ["submitted", "unknown"]),
        or(isNull(posts.nextReconcileAt), lte(posts.nextReconcileAt, now)),
        ...(opts.workspaceId ? [eq(posts.workspaceId, opts.workspaceId)] : []),
      ),
    )
    .orderBy(asc(posts.nextReconcileAt))
    .limit(opts.limit ?? 100);

  const out: ReconcileSummary = { checked: 0, changed: [] };
  for (const { id } of due) {
    const post = await loadPost(deps.db, null, id);
    if (!post || (post.state !== "submitted" && post.state !== "unknown")) continue;
    out.checked++;
    try {
      const after = await reconcileOne(deps, post);
      if (after.state !== post.state || after.generation !== post.generation) {
        out.changed.push({ postId: id, from: post.state, to: after.state });
      }
    } catch (err) {
      if (!(err instanceof PostConflict)) throw err;
    }
  }
  return out;
}

export async function reconcileOne(deps: PublishDeps, post: PostRow): Promise<PostRow> {
  const n = await attempts(deps, post);
  const ctx = ctxOf(deps);
  const [conn] = post.connectionId
    ? await deps.db.select().from(socialConnections).where(eq(socialConnections.id, post.connectionId))
    : [];
  if (!conn) return commitEvents(deps, post, [{ type: "still_pending", attempt: n }], ctx, WORKER);
  const adapter = (deps.adapterFor ?? publisher)(conn.publisher);
  const pctx = deps.ctxFor(post.workspaceId);

  if (post.state === "submitted") {
    let events: PostEvent[];
    try {
      const status = await adapter.status(pctx, {
        externalId: post.idempotencyKey,
        ...(post.providerRequestId ? { requestId: post.providerRequestId } : {}),
      });
      events = statusEvents(status, n);
    } catch {
      events = [{ type: "still_pending", attempt: n }];
    }
    const firstSubmittedAt = await submittedSince(deps, post);
    if (
      events[0]?.type === "still_pending" &&
      firstSubmittedAt &&
      ctx.now.getTime() - firstSubmittedAt.getTime() > SUBMITTED_GIVE_UP_HOURS * 3_600_000
    ) {
      events = [{ type: "failed", reason: "The posting service never confirmed this post. Check the account." }];
    }
    return commitEvents(deps, post, events, ctx, WORKER);
  }

  // unknown: never re-send until the lookup says "absent" (§4.3).
  let found: PublishStatus | "absent";
  try {
    found = await adapter.lookupByExternalId(pctx, post.idempotencyKey);
  } catch {
    return commitEvents(deps, post, [{ type: "still_pending", attempt: n }], ctx, WORKER);
  }
  if (found === "absent") {
    if (post.generation >= 3) return commitEvents(deps, post, [{ type: "lookup_absent" }], ctx, WORKER);
    return commitEvents(deps, post, [{ type: "lookup_absent" }, { type: "enqueue" }], ctx, WORKER);
  }
  const requestId = "requestId" in found ? found.requestId : undefined;
  const lookupFound: PostEvent = { type: "lookup_found", ...(requestId ? { requestId } : {}) };
  const rest = statusEvents(found, 0).filter((e) => e.type !== "still_pending");
  return commitEvents(deps, post, [lookupFound, ...rest], ctx, WORKER);
}

async function submittedSince(deps: PublishDeps, post: PostRow): Promise<Date | null> {
  const [row] = await deps.db
    .select({ at: postEvents.createdAt })
    .from(postEvents)
    .where(
      and(
        eq(postEvents.postId, post.id),
        eq(postEvents.toState, "submitted"),
        sql`${postEvents.data}->>'generation' = ${String(post.generation)}`,
      ),
    )
    .orderBy(asc(postEvents.createdAt))
    .limit(1);
  return row?.at ?? null;
}
