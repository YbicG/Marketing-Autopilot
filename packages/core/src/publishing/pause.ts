import { and, eq, inArray } from "drizzle-orm";
import { schema, uuidv7 } from "@mkt/db";
import { commitEvents, ctxOf, type PublishDeps } from "./due.ts";
import { scheduleEffects } from "./scheduler.ts";
import { applyEvent, loadPost, PostConflict, type Actor } from "./store.ts";

const { auditLog, posts } = schema;

type Deps = Pick<PublishDeps, "db" | "gateway" | "graceMin" | "now" | "scheduleAnalytics" | "notify">;

export interface PauseScope {
  workspaceId: string;
  /** Omit to pause everything in the workspace. */
  productId?: string;
}

async function postsIn(deps: Deps, scope: PauseScope, states: ("approved" | "queued" | "paused")[]) {
  return deps.db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.workspaceId, scope.workspaceId),
        inArray(posts.state, states),
        ...(scope.productId ? [eq(posts.productId, scope.productId)] : []),
      ),
    );
}

/**
 * "Pause all posting" (§5.8 step 5): every approved/queued post in scope → paused and its delayed
 * job removed. Everything is local; nothing needs cancelling at Upload-Post.
 */
export async function pausePosting(deps: Deps, scope: PauseScope, actor: Actor): Promise<{ paused: number }> {
  let paused = 0;
  for (const { id } of await postsIn(deps, scope, ["approved", "queued"])) {
    const post = await loadPost(deps.db, scope.workspaceId, id);
    if (!post || (post.state !== "approved" && post.state !== "queued")) continue;
    try {
      await commitEvents(deps, post, [{ type: "pause" }], ctxOf(deps), actor);
      paused++;
    } catch (err) {
      if (!(err instanceof PostConflict)) throw err;
    }
  }
  await deps.db.insert(auditLog).values({
    id: uuidv7(),
    workspaceId: scope.workspaceId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: "posting.pause",
    entity: scope.productId ? `product:${scope.productId}` : "workspace",
    data: { paused },
  });
  return { paused };
}

/** Resume: paused → approved → queued with its job back; slots already past the grace window → missed. */
export async function resumePosting(deps: Deps, scope: PauseScope, actor: Actor): Promise<{ queued: number; missed: number }> {
  let queued = 0;
  let missed = 0;
  for (const { id } of await postsIn(deps, scope, ["paused"])) {
    const post = await loadPost(deps.db, scope.workspaceId, id);
    if (!post || post.state !== "paused") continue;
    try {
      const after = await deps.db.transaction(async (tx) => {
        const r1 = await applyEvent(tx, post, { type: "resume" }, ctxOf(deps), actor);
        if (r1.post.state !== "approved") return r1;
        const r2 = await applyEvent(tx, r1.post, { type: "enqueue" }, ctxOf(deps), actor);
        return { post: r2.post, effects: [...r1.effects, ...r2.effects] };
      });
      await scheduleEffects({ gateway: deps.gateway, scheduleAnalytics: deps.scheduleAnalytics, notify: deps.notify }, id, after.effects);
      if (after.post.state === "missed") missed++;
      else queued++;
    } catch (err) {
      if (!(err instanceof PostConflict)) throw err;
    }
  }
  await deps.db.insert(auditLog).values({
    id: uuidv7(),
    workspaceId: scope.workspaceId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: "posting.resume",
    entity: scope.productId ? `product:${scope.productId}` : "workspace",
    data: { queued, missed },
  });
  return { queued, missed };
}
