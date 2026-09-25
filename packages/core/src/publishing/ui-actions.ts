import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { approvePosts, editPost, type ApproveOpts, type ApproveResult, type UiSession, type VoidResult } from "./approvals.ts";
import { checkCaps, loadCapContext, type CapPost } from "./caps.ts";
import type { TransitionCtx } from "./state-machine.ts";
import { applyEvent, applyEvents, loadPost, TransitionError, type Actor, type PostRow } from "./store.ts";

const { auditLog, contentItems, posts, products, variants, workspaces } = schema;

/** Queue-screen actions (§2.3 Queue, §4.3). Each returns the queue effects for the caller to apply. */

export class PostActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostActionError";
  }
}

const ctxOf = (opts: ApproveOpts): TransitionCtx => ({ now: opts.now ?? new Date(), graceMin: opts.graceMin ?? 120 });

async function tzOf(db: Db, workspaceId: string): Promise<string> {
  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws?.tz ?? "UTC";
}

const asCap = (p: Pick<PostRow, "id" | "productId" | "platform" | "connectionId" | "scheduledAt">): CapPost => ({
  id: p.id,
  productId: p.productId,
  platform: p.platform,
  connectionId: p.connectionId,
  scheduledAt: p.scheduledAt,
  // Whatever it is now, after the move it's planned to go out.
  state: "queued",
});

/**
 * The cap problems a move to `at` would create (§8 volume caps): the moved post's own, plus any
 * post on that day that would newly break a cap because this one moved in ahead of it.
 */
export async function rescheduleCapIssues(db: Db, post: PostRow, at: Date, tz: string): Promise<string[]> {
  const moved = asCap({ ...post, scheduledAt: at });
  const { connections, others } = await loadCapContext(db, { ...post, scheduledAt: at });
  const rest = others.filter((o) => o.id !== post.id);
  const all = [...rest, moved];
  const issues = new Set(checkCaps({ post: moved, others: all, connections, tz, mode: "plan" }).map((i) => i.message));
  for (const o of rest) {
    const beforeCodes = new Set(checkCaps({ post: o, others: rest, connections, tz, mode: "plan" }).map((i) => i.code));
    for (const i of checkCaps({ post: o, others: all, connections, tz, mode: "plan" })) {
      if (!beforeCodes.has(i.code)) issues.add(i.message);
    }
  }
  return [...issues];
}

const MOVABLE = ["draft", "pending_approval", "approved", "queued", "paused", "missed"];

/**
 * Drag-to-reschedule and "Reschedule" on a missed post. Refuses a time in the past or one that
 * breaks a cap. A queued post keeps its approval (the time isn't in the hash) and its delayed job
 * moves; a missed post goes missed → approved → queued at the new time.
 */
export async function reschedulePost(
  db: Db,
  workspaceId: string,
  postId: string,
  at: Date,
  actor: Actor,
  opts: ApproveOpts & { ignoreCaps?: boolean } = {},
): Promise<VoidResult> {
  const ctx = ctxOf(opts);
  const post = await loadPost(db, workspaceId, postId);
  if (!post) throw new PostActionError("That post is gone. Refresh the page.");
  if (!MOVABLE.includes(post.state)) throw new PostActionError(`This post is ${post.state.replace("_", " ")} and can't be moved.`);
  if (Number.isNaN(at.getTime()) || at.getTime() <= ctx.now.getTime()) throw new PostActionError("Pick a time in the future.");
  if (!opts.ignoreCaps) {
    const issues = await rescheduleCapIssues(db, post, at, await tzOf(db, workspaceId));
    if (issues.length) throw new PostActionError(`${issues.join(" ")} Pick another day.`);
  }

  if (post.state !== "missed") {
    const r = await editPost(db, workspaceId, postId, { scheduledAt: at }, actor, opts);
    return r ?? { postId, effects: [] };
  }
  return db.transaction(async (tx) => {
    const fresh = await loadPost(tx, workspaceId, postId);
    if (!fresh || fresh.state !== "missed") throw new PostActionError("This post changed. Refresh the page.");
    const r = await applyEvents(tx, fresh, [{ type: "reschedule", at }, { type: "enqueue" }], ctx, actor);
    return { postId, effects: r.effects };
  });
}

/** "Post now" on a missed post: missed → approved (slot = now) → queued, due immediately. */
export async function postNow(db: Db, workspaceId: string, postId: string, actor: Actor, opts: ApproveOpts = {}): Promise<VoidResult> {
  const ctx = ctxOf(opts);
  return db.transaction(async (tx) => {
    const post = await loadPost(tx, workspaceId, postId);
    if (!post) throw new PostActionError("That post is gone. Refresh the page.");
    if (post.state !== "missed") throw new PostActionError("Only a post that missed its slot can be posted now from here.");
    const r = await applyEvents(tx, post, [{ type: "post_now" }, { type: "enqueue" }], ctx, actor);
    return { postId, effects: r.effects };
  });
}

/** Cancel: any state before anything was sent → canceled, delayed job removed. */
export async function cancelPost(db: Db, workspaceId: string, postId: string, actor: Actor, opts: ApproveOpts = {}): Promise<VoidResult> {
  const ctx = ctxOf(opts);
  return db.transaction(async (tx) => {
    const post = await loadPost(tx, workspaceId, postId);
    if (!post) throw new PostActionError("That post is gone. Refresh the page.");
    try {
      const r = await applyEvent(tx, post, { type: "cancel" }, ctx, actor);
      return { postId, effects: r.effects };
    } catch (err) {
      if (err instanceof TransitionError) throw new PostActionError("This post is already on its way and can't be canceled.");
      throw err;
    }
  });
}

/** Pending API posts of finished videos (content item final_ready), soonest first. */
export async function finishedVideoPostIds(db: Db, workspaceId: string, opts: { productId?: string; now?: Date } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(variants, eq(variants.id, posts.variantId))
    .innerJoin(contentItems, eq(contentItems.id, variants.contentItemId))
    .where(
      and(
        eq(posts.workspaceId, workspaceId),
        eq(posts.state, "pending_approval"),
        eq(posts.mode, "api"),
        gte(posts.scheduledAt, now),
        eq(contentItems.kind, "video"),
        eq(contentItems.status, "final_ready"),
        ...(opts.productId ? [eq(posts.productId, opts.productId)] : []),
      ),
    )
    .orderBy(asc(posts.scheduledAt));
  return rows.map((r) => r.id);
}

/**
 * "Approve finished videos" (§2.3 Queue, D16 gate 2): approve every pending post of every
 * final_ready video, then move those videos final_ready → approved.
 */
export async function approveFinishedVideos(
  db: Db,
  session: UiSession,
  opts: ApproveOpts & { productId?: string } = {},
): Promise<ApproveResult> {
  const ids = await finishedVideoPostIds(db, session.workspaceId, opts);
  const res = await approvePosts(db, session, ids, opts);
  await markVideoItemsApproved(db, session.workspaceId, res.approved.map((a) => a.postId), opts.now);
  return res;
}

/**
 * A finished video (final_ready) becomes approved once any of its posts is approved (§4.3 video item).
 * Call after every approvePosts; items that aren't final_ready videos are left alone.
 */
export async function markVideoItemsApproved(db: Db, workspaceId: string, postIds: readonly string[], now = new Date()): Promise<void> {
  if (!postIds.length) return;
  const items = await db
    .selectDistinct({ id: contentItems.id })
    .from(posts)
    .innerJoin(variants, eq(variants.id, posts.variantId))
    .innerJoin(contentItems, eq(contentItems.id, variants.contentItemId))
    .where(and(eq(posts.workspaceId, workspaceId), inArray(posts.id, [...postIds])));
  if (!items.length) return;
  await db
    .update(contentItems)
    .set({ status: "approved", updatedAt: now })
    .where(
      and(
        eq(contentItems.workspaceId, workspaceId),
        eq(contentItems.status, "final_ready"),
        inArray(
          contentItems.id,
          items.map((i) => i.id),
        ),
      ),
    );
}

/** YouTube "made for kids", asked once per project (§2.3 TikTok composer row). */
export async function setMadeForKids(db: Db, workspaceId: string, productId: string, value: boolean, userId: string): Promise<void> {
  const rows = await db
    .update(products)
    .set({ madeForKids: value })
    .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)))
    .returning({ id: products.id });
  if (!rows.length) throw new PostActionError("Project not found.");
  await db.insert(auditLog).values({
    id: uuidv7(),
    workspaceId,
    actorType: "user",
    actorId: userId,
    action: "product.made_for_kids",
    entity: `product:${productId}`,
    data: { value },
  });
}
