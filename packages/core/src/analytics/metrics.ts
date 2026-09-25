import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { publisher, type MetricSnapshot, type Platform, type ProviderCtx, type PublisherAdapter } from "@mkt/providers";
import type { AnalyticsGateway, AnalyticsWindowName } from "../publishing/scheduler.ts";
import { ensureAnalyticsWindows, WINDOW_HOURS } from "./windows.ts";

const { analyticsSnapshots, posts, socialConnections } = schema;

export const METRIC_KEYS = [
  "views",
  "likes",
  "comments",
  "shares",
  "saves",
  "profileVisits",
  "follows",
  "linkClicks",
  "engagedViews",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** §5.9: nullable metrics; a 0 from an aggregator counts as unknown, never as a real zero. */
export function normalizeMetrics(s: MetricSnapshot | null): { metrics: Record<MetricKey, number | null>; unknown: MetricKey[] } {
  const metrics = {} as Record<MetricKey, number | null>;
  const unknown: MetricKey[] = [];
  for (const k of METRIC_KEYS) {
    const v = s?.[k];
    const known = typeof v === "number" && Number.isFinite(v) && v > 0 && !s?.unknown.includes(k);
    metrics[k] = known ? Math.round(v) : null;
    if (!known) unknown.push(k);
  }
  return { metrics, unknown };
}

export interface AnalyticsDeps {
  db: Db;
  ctxFor: (workspaceId: string) => ProviderCtx;
  adapterFor?: (publisherId: string) => PublisherAdapter;
  now?: () => Date;
}

export type PullOutcome = "saved" | "no_post" | "not_published" | "no_ref";

/** maint.analytics_pull for one post and window. Upserts analytics_snapshots (post, window). */
export async function pullPostMetrics(deps: AnalyticsDeps, data: { postId: string; window: AnalyticsWindowName }): Promise<PullOutcome> {
  const now = deps.now?.() ?? new Date();
  const [post] = await deps.db.select().from(posts).where(eq(posts.id, data.postId));
  if (!post) return "no_post";
  if (post.state !== "published" || !post.publishedAt) return "not_published";
  if (!post.providerPostId && !post.providerRequestId) return "no_ref";
  const [conn] = post.connectionId
    ? await deps.db.select().from(socialConnections).where(eq(socialConnections.id, post.connectionId))
    : [];
  if (!conn) return "no_ref";

  const adapter = (deps.adapterFor ?? publisher)(conn.publisher);
  let snap: MetricSnapshot | null = null;
  try {
    snap = await adapter.metrics(deps.ctxFor(post.workspaceId), {
      platform: post.platform as Platform,
      ...(post.providerPostId ? { postId: post.providerPostId } : {}),
      ...(post.providerRequestId ? { requestId: post.providerRequestId } : {}),
    });
  } catch {
    snap = null;
  }
  const { metrics, unknown } = normalizeMetrics(snap);
  const ageHours = Math.max(0, Math.floor((now.getTime() - post.publishedAt.getTime()) / 3_600_000));
  const mature = ageHours >= WINDOW_HOURS[data.window];
  await deps.db
    .insert(analyticsSnapshots)
    .values({
      id: uuidv7(),
      workspaceId: post.workspaceId,
      postId: post.id,
      window: data.window,
      ageHours,
      mature,
      metrics,
      unknownMetrics: unknown,
      source: conn.publisher,
    })
    .onConflictDoUpdate({
      target: [analyticsSnapshots.postId, analyticsSnapshots.window],
      set: { ageHours, mature, metrics, unknownMetrics: unknown, source: conn.publisher },
    });
  return "saved";
}

/** Called when a post is published (scheduleAnalytics effect). */
export function analyticsScheduler(gw: AnalyticsGateway) {
  return async (postId: string, publishedAt: Date) => {
    await ensureAnalyticsWindows(gw, postId, publishedAt);
  };
}
