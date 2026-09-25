import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@mkt/db";
import { contentProblems } from "./claims.ts";
import { commitEvents, ctxOf, type PublishDeps } from "./due.ts";
import { loadPost, PostConflict, type Actor } from "./store.ts";

const { posts } = schema;
const WORKER: Actor = { type: "worker" };

type Deps = Pick<PublishDeps, "db" | "gateway" | "graceMin" | "now" | "scheduleAnalytics" | "notify">;

/**
 * publish.stale_sweep (§5.8 step 6): daily and whenever DNA or claims change. Approved, queued and
 * paused posts whose claims were rejected, went non-public, expire before the slot, or whose profile
 * fields changed go back to pending_approval with the reason, and their jobs are removed.
 */
export async function staleSweep(
  deps: Deps,
  scope: { workspaceId?: string; productId?: string } = {},
): Promise<{ checked: number; stale: { postId: string; reason: string }[] }> {
  const rows = await deps.db
    .select({ id: posts.id, ws: posts.workspaceId })
    .from(posts)
    .where(
      and(
        inArray(posts.state, ["approved", "queued", "paused"]),
        ...(scope.workspaceId ? [eq(posts.workspaceId, scope.workspaceId)] : []),
        ...(scope.productId ? [eq(posts.productId, scope.productId)] : []),
      ),
    );
  const stale: { postId: string; reason: string }[] = [];
  for (const { id, ws } of rows) {
    const post = await loadPost(deps.db, ws, id);
    if (!post || !["approved", "queued", "paused"].includes(post.state)) continue;
    const ctx = ctxOf(deps);
    const problems = await contentProblems(deps.db, post.variantId, { scheduledAt: post.scheduledAt, now: ctx.now });
    if (!problems.length) continue;
    const reason = problems.join(" ");
    try {
      await commitEvents(deps, post, [{ type: "stale", reason }], ctx, WORKER);
      stale.push({ postId: id, reason });
    } catch (err) {
      if (!(err instanceof PostConflict)) throw err;
    }
  }
  return { checked: rows.length, stale };
}
