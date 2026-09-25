import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import type { AngleResultRow, ResultsByAngle, SignupSignal } from "@mkt/contracts";

const { analyticsSnapshots, angles, contentItems, conversionSnapshots, posts, strategies, variants } = schema;

/** §5.9: an angle is ranked once it has this many mature posts. */
export const MIN_MATURE_POSTS = 3;
/** Visits with zero signups at or above this count as a negative signup signal. */
export const SIGNUP_NEGATIVE_MIN_VISITS = 20;
const REWARD_TARGET_HOURS = 72;

type Metrics = Record<string, number | null>;

/** Intent signals per platform (§5.9), ranked above views. */
export function intentOf(platform: string, m: Metrics): number | null {
  const pick = (keys: string[]) => {
    const vals = keys.map((k) => m[k]).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  switch (platform) {
    case "instagram":
      return pick(["profileVisits", "follows", "linkClicks"]);
    case "youtube":
      return pick(["engagedViews"]);
    case "tiktok":
      return pick(["shares"]);
    case "x":
      return pick(["linkClicks"]);
    default:
      return pick(["linkClicks", "profileVisits", "follows"]);
  }
}

/** The reward snapshot: mature, and closest to 72 h. */
export function rewardSnapshot<T extends { ageHours: number; mature: boolean }>(snaps: T[]): T | null {
  let best: T | null = null;
  for (const s of snaps) {
    if (!s.mature) continue;
    if (!best || Math.abs(s.ageHours - REWARD_TARGET_HOURS) < Math.abs(best.ageHours - REWARD_TARGET_HOURS)) best = s;
  }
  return best;
}

export function signupSignal(conv: { visits: number; signups: number } | null): SignupSignal {
  if (!conv) return "none";
  if (conv.signups > 0) return "positive";
  if (conv.visits >= SIGNUP_NEGATIVE_MIN_VISITS) return "negative";
  return "neutral";
}

export interface AngleAgg {
  angleId: string;
  title: string;
  status: "active" | "stopped";
  posts: number;
  mature: { platform: string; metrics: Metrics }[];
  conv: { visits: number; signups: number } | null;
}

const sumOf = (vals: (number | null | undefined)[]) => {
  const xs = vals.filter((v): v is number => typeof v === "number");
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
};

/** Pure ranking step, exported for tests. No predicted scores: only measured numbers. */
export function rankAngles(aggs: AngleAgg[]): AngleResultRow[] {
  const rows = aggs.map((a) => {
    const views = sumOf(a.mature.map((p) => p.metrics.views));
    const both = a.mature.filter((p) => typeof p.metrics.views === "number" && typeof p.metrics.linkClicks === "number");
    const bothViews = sumOf(both.map((p) => p.metrics.views));
    const linkTapPct = bothViews ? Math.round((sumOf(both.map((p) => p.metrics.linkClicks))! / bothViews) * 1000) / 10 : null;
    const intents = a.mature.map((p) => intentOf(p.platform, p.metrics));
    const intentAvg = a.mature.length ? (sumOf(intents) ?? 0) / a.mature.length : 0;
    const viewsAvg = a.mature.length ? (views ?? 0) / a.mature.length : 0;
    const signal = signupSignal(a.conv);
    const row: AngleResultRow = {
      angleId: a.angleId,
      title: a.title,
      status: a.status,
      posts: a.posts,
      maturePosts: a.mature.length,
      views,
      linkTapPct,
      profileVisits: sumOf(a.mature.map((p) => p.metrics.profileVisits)),
      visits: a.conv?.visits ?? null,
      signups: a.conv?.signups ?? null,
      signupSignal: signal,
      rank: null,
      winner: false,
      canTurnIntoAd: false,
      note:
        a.mature.length >= MIN_MATURE_POSTS
          ? null
          : `Needs ${MIN_MATURE_POSTS - a.mature.length} more post${MIN_MATURE_POSTS - a.mature.length === 1 ? "" : "s"} with results before it's ranked.`,
    };
    return { row, key: [a.conv?.signups ?? -1, intentAvg, viewsAvg] as const };
  });
  const ranked = rows
    .filter((r) => r.row.maturePosts >= MIN_MATURE_POSTS)
    .sort((x, y) => y.key[0] - x.key[0] || y.key[1] - x.key[1] || y.key[2] - x.key[2]);
  ranked.forEach((r, i) => {
    r.row.rank = i + 1;
  });
  const top = ranked[0]?.row;
  if (top && top.signupSignal !== "none" && top.signupSignal !== "negative") {
    top.winner = true;
    top.canTurnIntoAd = true;
  }
  return [...ranked.map((r) => r.row), ...rows.filter((r) => r.row.rank === null).map((r) => r.row)];
}

/** Results v0: one row per angle for a product. */
export async function resultsByAngle(db: Db, workspaceId: string, productId: string): Promise<ResultsByAngle> {
  const published = await db
    .select({ id: posts.id, platform: posts.platform, angleId: contentItems.angleId })
    .from(posts)
    .innerJoin(variants, eq(variants.id, posts.variantId))
    .innerJoin(contentItems, eq(contentItems.id, variants.contentItemId))
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.productId, productId), eq(posts.state, "published")));

  const [latest] = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(and(eq(strategies.workspaceId, workspaceId), eq(strategies.productId, productId)))
    .orderBy(desc(strategies.createdAt))
    .limit(1);
  const usedAngleIds = [...new Set(published.map((p) => p.angleId).filter((x): x is string => !!x))];
  const angleRows = await db
    .select({ id: angles.id, card: angles.card, status: angles.status, strategyId: angles.strategyId, idx: angles.idx })
    .from(angles)
    .innerJoin(strategies, eq(strategies.id, angles.strategyId))
    .where(and(eq(angles.workspaceId, workspaceId), eq(strategies.productId, productId)));
  const shown = angleRows.filter((a) => a.strategyId === latest?.id || usedAngleIds.includes(a.id));

  const postIds = published.map((p) => p.id);
  const snaps = postIds.length
    ? await db
        .select({ postId: analyticsSnapshots.postId, ageHours: analyticsSnapshots.ageHours, mature: analyticsSnapshots.mature, metrics: analyticsSnapshots.metrics })
        .from(analyticsSnapshots)
        .where(inArray(analyticsSnapshots.postId, postIds))
    : [];
  const conv = await db
    .select({ term: conversionSnapshots.utmTerm, visits: conversionSnapshots.visits, signups: conversionSnapshots.signups })
    .from(conversionSnapshots)
    .where(and(eq(conversionSnapshots.workspaceId, workspaceId), eq(conversionSnapshots.productId, productId)));

  const aggs: AngleAgg[] = shown.map((a) => {
    const mine = published.filter((p) => p.angleId === a.id);
    const mature = mine.flatMap((p) => {
      const s = rewardSnapshot(snaps.filter((x) => x.postId === p.id));
      return s ? [{ platform: p.platform, metrics: s.metrics }] : [];
    });
    const c = conv.filter((r) => r.term === a.id);
    const title = typeof a.card.title === "string" ? a.card.title : `Angle ${a.idx + 1}`;
    return {
      angleId: a.id,
      title,
      status: a.status,
      posts: mine.length,
      mature,
      conv: c.length ? { visits: c.reduce((s, r) => s + r.visits, 0), signups: c.reduce((s, r) => s + r.signups, 0) } : null,
    };
  });
  return { productId, rows: rankAngles(aggs), minMaturePosts: MIN_MATURE_POSTS };
}
