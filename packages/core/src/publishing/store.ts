import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { PostState } from "@mkt/contracts";
import { approvalHash, canonicalJson } from "./hash.ts";
import { transition, type Effect, type PostEvent, type TransitionCtx } from "./state-machine.ts";

const { approvals, assets, postEvents, posts, variants } = schema;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
export type PostRow = typeof posts.$inferSelect;
export type ActorType = "user" | "pat" | "worker" | "webhook";
export interface Actor {
  type: ActorType;
  id?: string | null;
}

export class TransitionError extends Error {
  constructor(
    message: string,
    readonly postId: string,
    readonly from: PostState,
    readonly event: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

/** Another writer moved the post between our read and our update. */
export class PostConflict extends Error {
  constructor(readonly postId: string) {
    super(`post ${postId} changed underneath us`);
    this.name = "PostConflict";
  }
}

export async function loadPost(db: DbOrTx, workspaceId: string | null, postId: string): Promise<PostRow | null> {
  const where = workspaceId ? and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)) : eq(posts.id, postId);
  const [row] = await db.select().from(posts).where(where);
  return row ?? null;
}

/**
 * Apply one event to a post inside `tx`: optimistic update guarded by the current state, a
 * post_events row, and the DB-side effects (voiding an approval). Queue effects are returned for
 * scheduleEffects to run after the transaction commits (rehydrate repairs any we lose in between).
 */
export async function applyEvent(
  tx: DbOrTx,
  post: PostRow,
  event: PostEvent,
  ctx: TransitionCtx,
  actor: Actor,
  data?: Record<string, unknown>,
): Promise<{ post: PostRow; effects: Effect[] }> {
  const r = transition(post, event, ctx);
  if (!r.ok) throw new TransitionError(r.error, post.id, r.from, r.event);

  const [updated] = await tx
    .update(posts)
    .set({ ...r.patch, updatedAt: ctx.now })
    .where(and(eq(posts.id, post.id), eq(posts.state, post.state), eq(posts.generation, post.generation)))
    .returning();
  if (!updated) throw new PostConflict(post.id);

  const { type, ...eventData } = event;
  await tx.insert(postEvents).values({
    id: uuidv7(),
    workspaceId: post.workspaceId,
    postId: post.id,
    event: type,
    fromState: r.from,
    toState: r.to,
    actorType: actor.type,
    createdAt: ctx.now,
    data: { ...serializable(eventData), ...data, generation: post.generation, ...(actor.id ? { actorId: actor.id } : {}) },
  });

  for (const e of r.effects) {
    if (e.type === "voidApproval") {
      await tx
        .update(approvals)
        .set({ voidedAt: ctx.now, voidReason: e.reason })
        .where(and(eq(approvals.id, e.approvalId), isNull(approvals.voidedAt)));
    }
  }
  return { post: updated, effects: r.effects.filter((e) => e.type !== "voidApproval") };
}

/** Apply events in order (e.g. lookup_absent then enqueue), each on the row the previous one produced. */
export async function applyEvents(
  tx: DbOrTx,
  post: PostRow,
  events: PostEvent[],
  ctx: TransitionCtx,
  actor: Actor,
  data?: Record<string, unknown>,
): Promise<{ post: PostRow; effects: Effect[] }> {
  let cur = post;
  const effects: Effect[] = [];
  for (const ev of events) {
    const r = await applyEvent(tx, cur, ev, ctx, actor, data);
    cur = r.post;
    effects.push(...r.effects);
  }
  return { post: cur, effects };
}

function serializable(o: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonicalJson(o)) as Record<string, unknown>;
}

// ── what gets approved ──

export interface PublishText {
  text: string;
  title?: string;
  parts?: string[];
  firstComment?: string;
}

/**
 * The words that get posted, from a variant body. The copy factory's body shape is owned by
 * post-set contracts; this reads the common keys: text | caption | body, title, parts (threads), firstComment.
 */
export function publishText(raw: Record<string, unknown>): PublishText {
  // TextVariantBody (post-set.ts) wraps the PostVariant as { schemaVersion, kind, variant }.
  // CarouselVariantBody (carousel-spec.ts) carries its caption as { text, hashtags }.
  const body =
    raw.variant && typeof raw.variant === "object"
      ? (raw.variant as Record<string, unknown>)
      : raw.caption && typeof raw.caption === "object"
        ? (raw.caption as Record<string, unknown>)
        : raw;
  const str = (k: string) => (typeof body[k] === "string" && body[k] ? (body[k] as string) : undefined);
  let parts = Array.isArray(body.parts) ? body.parts.filter((p): p is string => typeof p === "string" && !!p) : [];
  let text = str("text") ?? str("caption") ?? str("body") ?? parts[0] ?? "";
  const tags = Array.isArray(body.hashtags) ? body.hashtags.filter((h): h is string => typeof h === "string" && !!h) : [];
  const tagLine = tags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const token = str("linkToken");
  const hasToken = (s: string) => /\{\{\s*link:/i.test(s);
  if (parts.length > 1) {
    // Thread: text = parts[0]; the link and hashtags go on the last part.
    let last = parts[parts.length - 1]!;
    if (token && !parts.some(hasToken)) last = `${last}\n\n${token}`;
    if (tagLine) last = `${last}\n\n${tagLine}`;
    parts = [...parts.slice(0, -1), last];
    text = parts[0]!;
  } else {
    if (token && !hasToken(text)) text = `${text}\n\n${token}`;
    if (tagLine) text = `${text}\n\n${tagLine}`;
    parts = [];
  }
  return {
    text,
    ...(str("title") ? { title: str("title") } : {}),
    ...(parts.length ? { parts } : {}),
    ...(str("firstComment") ? { firstComment: str("firstComment") } : {}),
  };
}

export interface ApprovableContent {
  variant: typeof variants.$inferSelect;
  media: (typeof assets.$inferSelect)[];
  text: PublishText;
  hash: string;
}

/** Current text + final media (in the variant's order) + options, and their approval hash. */
export async function currentContent(db: DbOrTx, post: PostRow): Promise<ApprovableContent | null> {
  const [variant] = await db
    .select()
    .from(variants)
    .where(and(eq(variants.id, post.variantId), eq(variants.workspaceId, post.workspaceId)));
  if (!variant) return null;
  const rows = variant.assetIds.length
    ? await db
        .select()
        .from(assets)
        .where(and(inArray(assets.id, variant.assetIds), eq(assets.workspaceId, post.workspaceId)))
    : [];
  const byId = new Map(rows.map((a) => [a.id, a]));
  const media = variant.assetIds.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
  if (media.length !== variant.assetIds.length) return null;
  const text = publishText(variant.body);
  const hash = approvalHash({
    text: canonicalJson(text),
    mediaSha256s: media.map((m) => m.sha256),
    platformOptions: post.platformOptions,
  });
  return { variant, media, text, hash };
}
