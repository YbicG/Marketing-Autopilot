import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { parsePlatformOptions } from "@mkt/contracts";
import { canonicalJson } from "./hash.ts";
import { applyEvent, applyEvents, currentContent, loadPost, type Actor, type PostRow, type Tx } from "./store.ts";
import type { DelayedPublishJob } from "./scheduler.ts";
import type { Effect, TransitionCtx } from "./state-machine.ts";

const { approvals, auditLog, posts } = schema;

declare const uiSessionBrand: unique symbol;

/**
 * Proof that the caller is a signed-in person in the web UI (D9). Only `uiSessionFromCookie`
 * mints one, and only apps/web route handlers call it, after better-auth resolved the cookie
 * session and the Origin + CSRF checks passed. PAT and MCP handlers authenticate differently and
 * never call it, so agents and tokens have no way to obtain a UiSession and can't approve.
 */
export interface UiSession {
  readonly userId: string;
  readonly workspaceId: string;
  readonly [uiSessionBrand]: true;
}

export function uiSessionFromCookie(verified: { userId: string; workspaceId: string; originChecked: true; csrfChecked: true }): UiSession {
  if (!verified.userId || !verified.workspaceId) throw new Error("A signed-in UI session is required to approve");
  return { userId: verified.userId, workspaceId: verified.workspaceId } as UiSession;
}

export interface ApproveResult {
  approved: { postId: string; approvalId: string }[];
  skipped: { postId: string; reason: string }[];
  /** Delayed publish.due jobs to add (also returned as effects for scheduleEffects). */
  jobs: DelayedPublishJob[];
  effects: { postId: string; effects: Effect[] }[];
}

export interface ApproveOpts {
  now?: Date;
  graceMin?: number;
}

/**
 * §5.8 step 1. For each pending post: normalize its options for the platform (TikTok privacy must be
 * chosen), hash text + final media + options, write the approvals row, audit_log and post_events, then
 * approved → queued. Returns the delayed jobs to enqueue.
 */
export async function approvePosts(db: Db, session: UiSession, postIds: string[], opts: ApproveOpts = {}): Promise<ApproveResult> {
  const now = opts.now ?? new Date();
  const ctx: TransitionCtx = { now, graceMin: opts.graceMin ?? 120 };
  const actor: Actor = { type: "user", id: session.userId };
  const out: ApproveResult = { approved: [], skipped: [], jobs: [], effects: [] };

  for (const postId of postIds) {
    const res = await db.transaction(async (tx) => {
      const post = await loadPost(tx, session.workspaceId, postId);
      if (!post) return { skip: "Post not found" };
      if (post.state !== "pending_approval") return { skip: `This post is ${post.state.replace("_", " ")}, not waiting for approval` };
      if (post.mode !== "api") return { skip: "Posted by hand; nothing to approve" };

      const parsed = parsePlatformOptions(post.platform, post.platformOptions);
      if (!parsed.success) return { skip: parsed.error.issues.map((i) => i.message).join(" ") };
      const options = parsed.data;
      const normalized = canonicalJson(options) === canonicalJson(post.platformOptions) ? post : await setOptions(tx, post, options);

      const content = await currentContent(tx, normalized);
      if (!content) return { skip: "This post's text or media is missing" };
      if (!content.text.text.trim() && content.media.length === 0) return { skip: "This post is empty" };

      const approvalId = uuidv7();
      await tx.insert(approvals).values({
        id: approvalId,
        workspaceId: post.workspaceId,
        entityType: "post",
        entityId: post.id,
        contentHash: content.hash,
        approvedBy: session.userId,
      });
      await tx
        .update(posts)
        .set({ mediaSnapshot: content.media.map((m) => ({ assetId: m.id, sha256: m.sha256 })) })
        .where(eq(posts.id, post.id));
      const fresh = (await loadPost(tx, post.workspaceId, post.id))!;
      const r = await applyEvents(tx, fresh, [{ type: "approve", approvalId }, { type: "enqueue" }], ctx, actor, {
        contentHash: content.hash,
      });
      await tx.insert(auditLog).values({
        id: uuidv7(),
        workspaceId: post.workspaceId,
        actorType: "user",
        actorId: session.userId,
        action: "post.approve",
        entity: `post:${post.id}`,
        data: { approvalId, contentHash: content.hash, scheduledAt: post.scheduledAt.toISOString() },
      });
      return { approvalId, effects: r.effects };
    });
    if ("skip" in res) {
      out.skipped.push({ postId, reason: res.skip! });
      continue;
    }
    out.approved.push({ postId, approvalId: res.approvalId });
    out.effects.push({ postId, effects: res.effects });
    for (const e of res.effects) {
      if (e.type === "addDelayedJob") out.jobs.push({ jobId: e.jobId, postId: e.postId, generation: e.generation, runAt: e.runAt });
    }
  }
  return out;
}

async function setOptions(tx: Tx, post: PostRow, options: Record<string, unknown>) {
  const [row] = await tx.update(posts).set({ platformOptions: options }).where(eq(posts.id, post.id)).returning();
  return row!;
}

/** Bulk "Approve next 7 days" on the Queue screen: every pending post due in the window, soonest first. */
export async function approveNextDays(
  db: Db,
  session: UiSession,
  opts: ApproveOpts & { days?: number; productId?: string } = {},
): Promise<ApproveResult> {
  const now = opts.now ?? new Date();
  const until = new Date(now.getTime() + (opts.days ?? 7) * 86_400_000);
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.workspaceId, session.workspaceId),
        eq(posts.state, "pending_approval"),
        eq(posts.mode, "api"),
        gte(posts.scheduledAt, now),
        lte(posts.scheduledAt, until),
        ...(opts.productId ? [eq(posts.productId, opts.productId)] : []),
      ),
    )
    .orderBy(asc(posts.scheduledAt));
  return approvePosts(
    db,
    session,
    rows.map((r) => r.id),
    opts,
  );
}

export interface VoidResult {
  postId: string;
  effects: Effect[];
}

/**
 * Void a post's approval (a re-render, an auto-fix, the user taking it back). Any actor may void:
 * voiding only ever removes permission to post. The post returns to pending_approval, job removed.
 */
export async function voidApproval(
  db: Db,
  workspaceId: string,
  postId: string,
  reason: string,
  actor: Actor,
  opts: ApproveOpts = {},
): Promise<VoidResult | null> {
  const ctx: TransitionCtx = { now: opts.now ?? new Date(), graceMin: opts.graceMin ?? 120 };
  return db.transaction(async (tx) => {
    const post = await loadPost(tx, workspaceId, postId);
    if (!post) return null;
    if (!["approved", "queued", "paused", "missed"].includes(post.state)) {
      if (post.approvalId) {
        await tx
          .update(approvals)
          .set({ voidedAt: ctx.now, voidReason: reason })
          .where(and(eq(approvals.id, post.approvalId), isNull(approvals.voidedAt)));
      }
      return { postId, effects: [] };
    }
    const r = await applyEvent(tx, post, { type: "void_approval", reason }, ctx, actor);
    await audit(tx, workspaceId, actor, "post.approval_void", postId, { reason });
    return { postId, effects: r.effects };
  });
}

export interface PostEdit {
  platformOptions?: Record<string, unknown>;
  scheduledAt?: Date;
}

/**
 * Post-level edits from the editor/Queue. Options change the approved hash, so an approved post
 * goes back to pending_approval with its job removed. Moving the time of a queued post keeps the
 * approval (the hash doesn't include the time) and moves the delayed job.
 */
export async function editPost(
  db: Db,
  workspaceId: string,
  postId: string,
  edit: PostEdit,
  actor: Actor,
  opts: ApproveOpts = {},
): Promise<VoidResult | null> {
  const ctx: TransitionCtx = { now: opts.now ?? new Date(), graceMin: opts.graceMin ?? 120 };
  return db.transaction(async (tx) => {
    let post = await loadPost(tx, workspaceId, postId);
    if (!post) return null;
    if (!["draft", "pending_approval", "approved", "queued", "paused", "missed", "failed"].includes(post.state)) {
      throw new Error(`A post that is ${post.state} can't be edited`);
    }
    const set: Partial<PostRow> = {};
    if (edit.platformOptions) set.platformOptions = edit.platformOptions;
    if (edit.scheduledAt) set.scheduledAt = edit.scheduledAt;
    const [row] = await tx.update(posts).set(set).where(eq(posts.id, post.id)).returning();
    post = row!;
    const effects: Effect[] = [];
    if (edit.platformOptions) {
      const r = await invalidateIfChanged(tx, post, ctx, actor);
      post = r.post;
      effects.push(...r.effects);
    }
    if (edit.scheduledAt && post.state === "queued") {
      const r = await applyEvent(tx, post, { type: "enqueue" }, ctx, actor, { rescheduled: true });
      effects.push(...r.effects);
    }
    await audit(tx, workspaceId, actor, "post.edit", postId, {
      fields: Object.keys(edit),
    });
    return { postId, effects };
  });
}

/**
 * Called after a variant's text or media changed (editor save, re-render, auto-fix): every post
 * of that variant whose current hash no longer matches its approval goes back to pending_approval.
 */
export async function onVariantChanged(
  db: Db,
  workspaceId: string,
  variantId: string,
  actor: Actor,
  opts: ApproveOpts = {},
): Promise<VoidResult[]> {
  const ctx: TransitionCtx = { now: opts.now ?? new Date(), graceMin: opts.graceMin ?? 120 };
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.variantId, variantId)));
  const out: VoidResult[] = [];
  for (const { id } of rows) {
    const r = await db.transaction(async (tx) => {
      const post = await loadPost(tx, workspaceId, id);
      if (!post) return null;
      return invalidateIfChanged(tx, post, ctx, actor);
    });
    if (r && r.effects.length) out.push({ postId: id, effects: r.effects });
  }
  return out;
}

async function invalidateIfChanged(
  tx: Tx,
  post: PostRow,
  ctx: TransitionCtx,
  actor: Actor,
): Promise<{ post: PostRow; effects: Effect[] }> {
  if (!["approved", "queued", "paused", "missed", "failed"].includes(post.state)) {
    return { post, effects: [] };
  }
  if (post.state !== "failed" && post.approvalId) {
    const [appr] = await tx.select().from(approvals).where(eq(approvals.id, post.approvalId));
    const content = await currentContent(tx, post);
    if (appr && !appr.voidedAt && content && content.hash === appr.contentHash) return { post, effects: [] };
  }
  return applyEvent(tx, post, { type: "edit" }, ctx, actor);
}

async function audit(
  tx: Tx,
  workspaceId: string,
  actor: Actor,
  action: string,
  postId: string,
  data: Record<string, unknown>,
) {
  await tx.insert(auditLog).values({
    id: uuidv7(),
    workspaceId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action,
    entity: `post:${postId}`,
    data,
  });
}

/** True when the post has a live approval whose hash matches `hash`. Used by prepare. */
export async function approvalMatches(db: Tx | Db, post: PostRow, hash: string) {
  if (!post.approvalId) return { ok: false as const, reason: "No approval on record" };
  const [appr] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, post.approvalId), eq(approvals.workspaceId, post.workspaceId), inArray(approvals.entityType, ["post"])));
  if (!appr || appr.entityId !== post.id) return { ok: false as const, reason: "No approval on record" };
  if (appr.voidedAt) return { ok: false as const, reason: appr.voidReason ?? "The approval was withdrawn" };
  if (appr.contentHash !== hash) return { ok: false as const, reason: "Changed since you approved it" };
  if (!appr.approvedBy) return { ok: false as const, reason: "No approver on record" };
  return { ok: true as const };
}

