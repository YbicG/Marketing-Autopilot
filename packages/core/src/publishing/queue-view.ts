import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import type { PostState } from "@mkt/contracts";
import { checkCaps, PLANNED_STATES, type CapPost } from "./caps.ts";
import { localDay, shortSlot } from "./time.ts";

const { posts, socialConnections, workspaces } = schema;

export interface QueuePost {
  id: string;
  productId: string;
  platform: string;
  scheduledAt: Date;
  state: PostState;
  mode: string;
  handle: string | null;
  lastError: string | null;
  staleReason: string | null;
  platformUrl: string | null;
  /** Plain-English cap problems if this post went out as planned. */
  conflicts: string[];
}

export interface QueueDay {
  day: string;
  posts: QueuePost[];
}

export interface NeedsYouItem {
  kind: "missed" | "failed" | "reconnect" | "finish_in_app" | "approve";
  postId?: string;
  connectionId?: string;
  message: string;
}

export interface QueueView {
  days: QueueDay[];
  /** "Next post Tue 7:30 pm", "Posting is paused", or "Nothing scheduled". */
  statusLine: string;
  needsYou: NeedsYouItem[];
}

/**
 * Data for the Queue screen (§2.3): posts in [from, to) grouped by local day with cap conflicts
 * flagged, the status line, and the Needs-you list (missed, failed, reconnect, finish in TikTok).
 */
export async function queueView(
  db: Db,
  workspaceId: string,
  opts: { from: Date; to: Date; productId?: string; now?: Date },
): Promise<QueueView> {
  const now = opts.now ?? new Date();
  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const tz = ws?.tz ?? "UTC";
  const scope = opts.productId ? [eq(posts.productId, opts.productId)] : [];

  const rows = await db
    .select({ post: posts, handle: socialConnections.handle })
    .from(posts)
    .leftJoin(socialConnections, eq(socialConnections.id, posts.connectionId))
    .where(and(eq(posts.workspaceId, workspaceId), gte(posts.scheduledAt, opts.from), lt(posts.scheduledAt, opts.to), ...scope))
    .orderBy(asc(posts.scheduledAt), asc(posts.id));
  const connections = await db.select().from(socialConnections).where(eq(socialConnections.workspaceId, workspaceId));

  // Conflicts count posts of every product (shared accounts cross products), not just the filtered ones.
  const pad = 36 * 3_600_000;
  const capRows: CapPost[] = await db
    .select({
      id: posts.id,
      productId: posts.productId,
      platform: posts.platform,
      connectionId: posts.connectionId,
      scheduledAt: posts.scheduledAt,
      state: posts.state,
    })
    .from(posts)
    .where(
      and(
        eq(posts.workspaceId, workspaceId),
        gte(posts.scheduledAt, new Date(opts.from.getTime() - pad)),
        lt(posts.scheduledAt, new Date(opts.to.getTime() + pad)),
        inArray(posts.state, [...PLANNED_STATES]),
      ),
    );

  const byDay = new Map<string, QueuePost[]>();
  for (const { post, handle } of rows) {
    const conflicts = PLANNED_STATES.includes(post.state)
      ? checkCaps({ post, others: capRows, connections, tz, mode: "plan" }).map((i) => i.message)
      : [];
    const day = localDay(post.scheduledAt, tz);
    const list = byDay.get(day) ?? [];
    list.push({
      id: post.id,
      productId: post.productId,
      platform: post.platform,
      scheduledAt: post.scheduledAt,
      state: post.state,
      mode: post.mode,
      handle,
      lastError: post.lastError,
      staleReason: post.staleReason,
      platformUrl: post.platformUrl,
      conflicts,
    });
    byDay.set(day, list);
  }

  const [next] = await db
    .select({ at: posts.scheduledAt })
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.state, "queued"), gte(posts.scheduledAt, now), ...scope))
    .orderBy(asc(posts.scheduledAt))
    .limit(1);
  const [paused] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.state, "paused"), ...scope))
    .limit(1);
  const statusLine = next
    ? `Next post ${shortSlot(next.at, tz)}${paused ? " (some posts are paused)" : ""}`
    : paused
      ? "Posting is paused"
      : "Nothing scheduled";

  const attention = await db
    .select()
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), inArray(posts.state, ["missed", "failed", "awaiting_user"]), ...scope))
    .orderBy(asc(posts.scheduledAt));
  const needsYou: NeedsYouItem[] = attention.map((p) => {
    if (p.state === "missed") {
      return { kind: "missed", postId: p.id, message: `Missed its ${shortSlot(p.scheduledAt, tz)} slot while the server was down. Post now or pick a new time.` };
    }
    if (p.state === "awaiting_user") {
      return { kind: "finish_in_app", postId: p.id, message: "Waiting in your TikTok drafts. Finish it in the TikTok app, then mark it done." };
    }
    return { kind: "failed", postId: p.id, message: p.lastError ?? "This post didn't go out." };
  });
  for (const c of connections) {
    if (c.status === "reauth_required" || c.status === "error") {
      needsYou.push({
        kind: "reconnect",
        connectionId: c.id,
        message: `Reconnect ${c.handle ? `@${c.handle.replace(/^@/, "")}` : `your ${c.platform} account`} so its posts can go out.`,
      });
    }
  }

  return {
    days: [...byDay.entries()].map(([day, list]) => ({ day, posts: list })),
    statusLine,
    needsYou,
  };
}
