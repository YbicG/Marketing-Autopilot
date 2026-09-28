import { and, asc, count, desc, eq, gte, inArray, lt, min } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";

const { campaigns, contentItems, generationRuns, launchPlans, posts, products, socialConnections } = schema;

/** The five stages on a project card, in order. */
export const PROJECT_STAGES = ["Understood", "Plan", "Content", "Posting", "Learning"] as const;

export interface StageFlags {
  hasProfile: boolean;
  hasCampaign: boolean;
  hasContent: boolean;
  hasPlannedOrPublished: boolean;
  firstPublishedAt: Date | null;
}

const LEARNING_AFTER_MS = 3 * 86_400_000;

/**
 * How many stages are done (0-5). A stage counts only if every earlier one does, so a project with
 * posts but no profile still reads as "not understood yet". Learning starts 3 days after the first post.
 */
export function projectStage(f: StageFlags, now: Date): number {
  const steps = [
    f.hasProfile,
    f.hasCampaign,
    f.hasContent,
    f.hasPlannedOrPublished,
    f.firstPublishedAt !== null && now.getTime() - f.firstPublishedAt.getTime() >= LEARNING_AFTER_MS,
  ];
  const firstMissing = steps.indexOf(false);
  return firstMissing === -1 ? steps.length : firstMissing;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  status: "active" | "parked";
  /** Stages done, 0-5 (see PROJECT_STAGES). */
  stage: number;
  /** A run for this project is queued or working (reading the product, planning, making content). */
  working: boolean;
  nextPostAt: Date | null;
  launchDate: string | null;
  postsThisWeek: number;
  waitingApproval: number;
  /** Missed, failed or waiting in TikTok drafts. Reconnects are workspace-wide and counted separately. */
  attention: number;
}

const PLANNED: (typeof schema.POST_STATES)[number][] = ["pending_approval", "approved", "queued", "preparing", "submitting", "submitted", "published"];

/** One row per project for the home grid and the sidebar, newest first. A handful of grouped queries, not one per project. */
export async function projectSummaries(db: Db, workspaceId: string, now = new Date()): Promise<ProjectSummary[]> {
  const list = await db
    .select({ id: products.id, slug: products.slug, name: products.name, status: products.status, dna: products.currentDnaVersionId })
    .from(products)
    .where(eq(products.workspaceId, workspaceId))
    .orderBy(desc(products.createdAt));
  if (list.length === 0) return [];
  const ids = list.map((p) => p.id);
  const inWs = eq(posts.workspaceId, workspaceId);
  const weekEnd = new Date(now.getTime() + 7 * 86_400_000);

  const [camp, content, planned, published, next, week, waiting, attention, runs, launch] = await Promise.all([
    db.select({ p: campaigns.productId, n: count() }).from(campaigns).where(inArray(campaigns.productId, ids)).groupBy(campaigns.productId),
    db
      .select({ p: campaigns.productId, n: count() })
      .from(contentItems)
      .innerJoin(campaigns, eq(campaigns.id, contentItems.campaignId))
      .where(inArray(campaigns.productId, ids))
      .groupBy(campaigns.productId),
    db.select({ p: posts.productId, n: count() }).from(posts).where(and(inWs, inArray(posts.state, PLANNED))).groupBy(posts.productId),
    db.select({ p: posts.productId, at: min(posts.publishedAt) }).from(posts).where(and(inWs, eq(posts.state, "published"))).groupBy(posts.productId),
    db.select({ p: posts.productId, at: min(posts.scheduledAt) }).from(posts).where(and(inWs, eq(posts.state, "queued"), gte(posts.scheduledAt, now))).groupBy(posts.productId),
    db
      .select({ p: posts.productId, n: count() })
      .from(posts)
      .where(and(inWs, inArray(posts.state, PLANNED), gte(posts.scheduledAt, now), lt(posts.scheduledAt, weekEnd)))
      .groupBy(posts.productId),
    db.select({ p: posts.productId, n: count() }).from(posts).where(and(inWs, eq(posts.state, "pending_approval"))).groupBy(posts.productId),
    db
      .select({ p: posts.productId, n: count() })
      .from(posts)
      .where(and(inWs, inArray(posts.state, ["missed", "failed", "awaiting_user"])))
      .groupBy(posts.productId),
    db
      .select({ p: generationRuns.productId, input: generationRuns.input })
      .from(generationRuns)
      .where(and(eq(generationRuns.workspaceId, workspaceId), inArray(generationRuns.status, ["queued", "running"]))),
    db
      .select({ p: launchPlans.productId, day: launchPlans.launchDate })
      .from(launchPlans)
      .where(and(inArray(launchPlans.productId, ids), inArray(launchPlans.status, ["draft", "active"])))
      .orderBy(asc(launchPlans.launchDate)),
  ]);

  const num = (rows: { p: string | null; n: number }[]) => new Map(rows.map((r) => [r.p, Number(r.n)]));
  const campN = num(camp);
  const contentN = num(content);
  const plannedN = num(planned);
  const weekN = num(week);
  const waitingN = num(waiting);
  const attentionN = num(attention);
  const firstPub = new Map(published.map((r) => [r.p, r.at ? new Date(r.at) : null]));
  const nextAt = new Map(next.map((r) => [r.p, r.at ? new Date(r.at) : null]));
  const launchDay = new Map<string, string>();
  for (const l of launch) if (!launchDay.has(l.p)) launchDay.set(l.p, l.day);
  const slugOf = new Map(list.map((p) => [p.slug, p.id]));
  const busy = new Set<string>();
  for (const r of runs) {
    // Ingest runs start before the product row exists, so they carry the slug in their input instead.
    const id = r.p ?? (typeof r.input.slug === "string" ? slugOf.get(r.input.slug) : undefined);
    if (id) busy.add(id);
  }

  return list.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    status: p.status,
    stage: projectStage(
      {
        hasProfile: p.dna !== null,
        hasCampaign: (campN.get(p.id) ?? 0) > 0,
        hasContent: (contentN.get(p.id) ?? 0) > 0,
        hasPlannedOrPublished: (plannedN.get(p.id) ?? 0) > 0,
        firstPublishedAt: firstPub.get(p.id) ?? null,
      },
      now,
    ),
    working: busy.has(p.id),
    nextPostAt: nextAt.get(p.id) ?? null,
    launchDate: launchDay.get(p.id) ?? null,
    postsThisWeek: weekN.get(p.id) ?? 0,
    waitingApproval: waitingN.get(p.id) ?? 0,
    attention: attentionN.get(p.id) ?? 0,
  }));
}

/** Social accounts that need signing in again; they block posts for every project that uses them. */
export async function reconnectCount(db: Db, workspaceId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(socialConnections)
    .where(and(eq(socialConnections.workspaceId, workspaceId), inArray(socialConnections.status, ["reauth_required", "error"])));
  return Number(r?.n ?? 0);
}
