import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@mkt/db";
import type { WebhookEvent } from "@mkt/providers";
import { commitEvents, ctxOf, type PublishDeps } from "./due.ts";
import type { PostEvent } from "./state-machine.ts";
import type { Actor, PostRow } from "./store.ts";

const { posts, socialConnections, webhookEvents } = schema;
const WEBHOOK: Actor = { type: "webhook" };

type WebhookRow = typeof webhookEvents.$inferSelect;

/**
 * The web route verifies the HMAC over the raw body (adapter.parseWebhook) before storing the row;
 * the worker only needs the parsed event back. Default: the route stored the normalized
 * WebhookEvent JSON in `body`, or the adapter can re-parse without a signature check.
 */
export type WebhookDecoder = (row: WebhookRow) => WebhookEvent;

export const decodeStoredWebhook: WebhookDecoder = (row) => {
  const parsed = JSON.parse(row.body) as Partial<WebhookEvent> & { kind?: string };
  if (parsed && typeof parsed.kind === "string") return parsed as WebhookEvent;
  return { kind: "ignored", eventId: row.eventId, type: row.type ?? "unknown" };
};

const KEY = /^pst_([0-9a-f-]{36})_g(\d+)$/i;

async function findPost(deps: PublishDeps, e: { externalId?: string; requestId?: string }): Promise<{ post: PostRow | null; olderGeneration: boolean }> {
  if (e.externalId) {
    const [p] = await deps.db.select().from(posts).where(eq(posts.idempotencyKey, e.externalId));
    if (p) return { post: p, olderGeneration: false };
    const m = KEY.exec(e.externalId);
    if (m) {
      const [byId] = await deps.db.select().from(posts).where(eq(posts.id, m[1]!));
      if (byId) return { post: byId, olderGeneration: Number(m[2]) < byId.generation };
    }
  }
  if (e.requestId) {
    const [p] = await deps.db.select().from(posts).where(eq(posts.providerRequestId, e.requestId));
    if (p) return { post: p, olderGeneration: false };
  }
  return { post: null, olderGeneration: false };
}

/** What a webhook means for a post in its current state. Empty = nothing to do (duplicate or late). */
export function eventsForWebhook(post: PostRow, e: WebhookEvent): PostEvent[] {
  const found: PostEvent[] = post.state === "unknown" ? [{ type: "lookup_found" }] : [];
  const live = ["submitting", "submitted", "unknown"].includes(post.state);
  switch (e.kind) {
    case "upload_completed":
      if (live || post.state === "awaiting_user") {
        return [...found, { type: "published", ...(e.url ? { url: e.url } : {}), ...(e.postId ? { providerPostId: e.postId } : {}), ...(e.requestId ? { requestId: e.requestId } : {}) }];
      }
      return [];
    case "upload_failed":
      return live ? [...found, { type: "failed", reason: e.reason || "The platform rejected this post." }] : [];
    case "inbox_fallback":
      return live ? [...found, { type: "drafts_mode", reason: "TikTok sent this to your drafts. Finish it in the TikTok app." }] : [];
    default:
      return [];
  }
}

export type WebhookOutcome = "duplicate" | "processed" | "no_match" | "ignored";

/** publish.webhook: idempotent; a row is processed once, and a repeat event for a post that already moved is a no-op. */
export async function processWebhookEvent(
  deps: PublishDeps,
  webhookEventId: string,
  decode: WebhookDecoder = decodeStoredWebhook,
): Promise<WebhookOutcome> {
  const [row] = await deps.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId));
  if (!row || row.processedAt) return "duplicate";
  const ctx = ctxOf(deps);
  const done = (patch: { workspaceId?: string | null; error?: string | null }) =>
    deps.db
      .update(webhookEvents)
      .set({ processedAt: ctx.now, ...patch })
      .where(eq(webhookEvents.id, row.id));

  let e: WebhookEvent;
  try {
    e = decode(row);
  } catch (err) {
    await done({ error: `could not parse: ${(err as Error).message}` });
    return "ignored";
  }

  if (e.kind === "ignored") {
    await done({});
    return "ignored";
  }

  if (e.kind === "reauth_required") {
    if (!e.profileRef) {
      await done({ error: "reauth without profile" });
      return "no_match";
    }
    const updated = await deps.db
      .update(socialConnections)
      .set({ status: "reauth_required" })
      .where(
        and(
          eq(socialConnections.profileRef, e.profileRef),
          ...(e.platform ? [eq(socialConnections.platform, e.platform)] : []),
          inArray(socialConnections.status, ["active", "error"]),
        ),
      )
      .returning({ ws: socialConnections.workspaceId });
    await done({ workspaceId: updated[0]?.ws ?? null });
    return updated.length ? "processed" : "no_match";
  }

  const { post, olderGeneration } = await findPost(deps, e);
  if (!post) {
    await done({ error: "no matching post" });
    return "no_match";
  }
  if (olderGeneration) {
    // An earlier attempt that lookup had called absent turned up after all. Record it; a human decides.
    await done({ workspaceId: post.workspaceId, error: `event for an earlier attempt of post ${post.id}` });
    await deps.notify?.(post.id, "failed", "An earlier attempt of this post may have gone out too. Check the account.");
    return "processed";
  }
  const events = eventsForWebhook(post, e);
  if (events.length) await commitEvents(deps, post, events, ctx, WEBHOOK, { data: { webhookEventId: row.id } });
  await done({ workspaceId: post.workspaceId });
  return "processed";
}
