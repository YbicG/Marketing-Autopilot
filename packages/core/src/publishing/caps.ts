import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { schema } from "@mkt/db";
import type { PostState } from "@mkt/contracts";
import type { DbOrTx, PostRow } from "./store.ts";
import { localDay, HOUR_MS } from "./time.ts";
import { tiktokDailyLimit } from "./tiktok.ts";

const { posts, socialConnections } = schema;

/** §8 volume caps. */
export const PRODUCT_PLATFORM_DAILY_CAP = 2;
export const CONNECTION_HARD_MAX = 3;
export const WARMUP_DAILY = 1;

/** Posts that have gone (or are going) out: what prepare counts against today's caps. */
export const SENT_STATES: readonly PostState[] = ["submitting", "submitted", "unknown", "awaiting_user", "published"];
/** Everything that will go out unless someone stops it: what the Queue screen flags conflicts over. */
export const PLANNED_STATES: readonly PostState[] = [
  "pending_approval",
  "approved",
  "queued",
  "preparing",
  ...SENT_STATES,
];

export interface CapPost {
  id: string;
  productId: string;
  platform: string;
  connectionId: string | null;
  scheduledAt: Date;
  state: PostState;
}

export interface CapConnection {
  id: string;
  platform: string;
  handle: string | null;
  shared: boolean;
  maxPerDay: number;
  warmupUntil: Date | null;
  createdAt: Date;
}

export interface CapIssue {
  code: "cap.product_platform" | "cap.account" | "cap.warmup" | "cap.tiktok";
  message: string;
}

/**
 * Personal X/Bluesky/LinkedIn accounts are connected once per product (one Upload-Post profile
 * each) but are one account: shared connections with the same platform + handle share a cap.
 */
export function accountKey(c: CapConnection): string {
  return c.shared && c.handle ? `shared:${c.platform}:${c.handle.toLowerCase().replace(/^@/, "")}` : `conn:${c.id}`;
}

/** The daily limit for an account group at `at`: the tightest member, never above 3; warm-up and TikTok rules on top. */
export function accountDailyLimit(group: CapConnection[], at: Date): { limit: number; reason: CapIssue["code"] } {
  let limit = Math.min(CONNECTION_HARD_MAX, ...group.map((c) => c.maxPerDay));
  let reason: CapIssue["code"] = "cap.account";
  for (const c of group) {
    if (c.platform === "tiktok") {
      const t = tiktokDailyLimit(c, at);
      if (t < limit) {
        limit = t;
        reason = "cap.tiktok";
      }
    } else if (c.warmupUntil && at.getTime() < c.warmupUntil.getTime() && WARMUP_DAILY < limit) {
      limit = WARMUP_DAILY;
      reason = "cap.warmup";
    }
  }
  return { limit, reason };
}

const ahead = (a: CapPost, b: CapPost) =>
  a.scheduledAt.getTime() < b.scheduledAt.getTime() || (a.scheduledAt.getTime() === b.scheduledAt.getTime() && a.id < b.id);

/**
 * Cap check for one post against the others. `countAll`: count every post in `others` (the Queue
 * view passes already-filtered planned posts and asks about the ones ahead); otherwise only sent
 * posts plus preparing posts ahead of this one count, so two posts preparing at once can't both block.
 */
export function checkCaps(input: {
  post: CapPost;
  others: CapPost[];
  connections: CapConnection[];
  tz: string;
  mode: "prepare" | "plan";
}): CapIssue[] {
  const { post, tz } = input;
  const day = localDay(post.scheduledAt, tz);
  const counts = input.others.filter((o) => {
    if (o.id === post.id || localDay(o.scheduledAt, tz) !== day) return false;
    if (input.mode === "plan") return PLANNED_STATES.includes(o.state) && ahead(o, post);
    return SENT_STATES.includes(o.state) || (o.state === "preparing" && ahead(o, post));
  });
  const issues: CapIssue[] = [];

  const samePlatform = counts.filter((o) => o.productId === post.productId && o.platform === post.platform).length;
  if (samePlatform >= PRODUCT_PLATFORM_DAILY_CAP) {
    issues.push({
      code: "cap.product_platform",
      message: `Already ${PRODUCT_PLATFORM_DAILY_CAP} ${post.platform} posts for this product that day.`,
    });
  }

  const conn = input.connections.find((c) => c.id === post.connectionId);
  if (conn) {
    const key = accountKey(conn);
    const group = input.connections.filter((c) => accountKey(c) === key);
    const ids = new Set(group.map((c) => c.id));
    const used = counts.filter((o) => o.connectionId && ids.has(o.connectionId)).length;
    const { limit, reason } = accountDailyLimit(group, post.scheduledAt);
    if (used >= limit) {
      const who = conn.handle ? `@${conn.handle.replace(/^@/, "")}` : "This account";
      issues.push({
        code: reason,
        message:
          reason === "cap.warmup" || (reason === "cap.tiktok" && limit === 1)
            ? `${who} is new, so it posts once a day for its first week.`
            : `${who} already has ${limit} post${limit === 1 ? "" : "s"} that day${conn.shared ? " across your products" : ""}.`,
      });
    }
  }
  return issues;
}

export async function loadCapContext(db: DbOrTx, post: PostRow) {
  const from = new Date(post.scheduledAt.getTime() - 36 * HOUR_MS);
  const to = new Date(post.scheduledAt.getTime() + 36 * HOUR_MS);
  const connections = await db
    .select()
    .from(socialConnections)
    .where(and(eq(socialConnections.workspaceId, post.workspaceId), eq(socialConnections.platform, post.platform)));
  const others = await db
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
        eq(posts.workspaceId, post.workspaceId),
        eq(posts.platform, post.platform),
        gte(posts.scheduledAt, from),
        lte(posts.scheduledAt, to),
        inArray(posts.state, [...PLANNED_STATES]),
      ),
    );
  return { connections, others };
}
