import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { checkCaps, loadCapContext, PLANNED_STATES } from "./caps.ts";
import { finishedVideoPostIds } from "./ui-actions.ts";
import { assistedDeepLink, rulesCheckedToday } from "./manual.ts";
import { effectiveTier, type Tier } from "./provenance.ts";
import { currentContent, loadPost, publishText, type PublishText } from "./store.ts";
import { localDay, shortSlot, DAY_MS } from "./time.ts";
import { addDays, dayBounds, localTime } from "./zoned.ts";

const { analyticsSnapshots, approvals, assets, assistedTasks, contentItems, conversionSnapshots, posts, socialConnections, variants, webhookEvents, workspaces, products } =
  schema;

/** Read models for the Queue post drawer and the Today screen (§2.2, §2.3). Workspace-scoped. */

async function tzOf(db: Db, workspaceId: string): Promise<string> {
  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws?.tz ?? "UTC";
}

export interface DrawerMedia {
  assetId: string;
  mime: string;
  kind: string;
  /** Platform-ready download name, e.g. "tiktok-1.mp4". */
  filename: string;
  durationMs: number | null;
}

export interface PostDetail {
  id: string;
  productId: string;
  productSlug: string;
  madeForKids: boolean | null;
  platform: string;
  state: string;
  mode: string;
  scheduledAt: Date;
  /** "Tue 7:30 pm" in the workspace time zone. */
  slot: string;
  day: string;
  time: string;
  text: PublishText;
  media: DrawerMedia[];
  connection: { id: string; handle: string | null; status: string; publisher: string } | null;
  /** A publisher can post this for us; false → "Download & post yourself". */
  canAutoPost: boolean;
  platformOptions: Record<string, unknown>;
  lastError: string | null;
  staleReason: string | null;
  platformUrl: string | null;
  conflicts: string[];
  tier: Tier;
  contentKind: string | null;
  contentStatus: string | null;
  /** Promotes the product (a link or a sign-up nudge): the TikTok composer warns about disclosure. */
  promotional: boolean;
  approvedAt: Date | null;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};

export function downloadName(platform: string, idx: number, mime: string): string {
  return `${platform}-${idx + 1}.${EXT[mime] ?? "bin"}`;
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\{\{\s*link:/i;

export async function postDetail(db: Db, workspaceId: string, postId: string): Promise<PostDetail | null> {
  const post = await loadPost(db, workspaceId, postId);
  if (!post) return null;
  const tz = await tzOf(db, workspaceId);
  const [product] = await db
    .select({ slug: products.slug, madeForKids: products.madeForKids })
    .from(products)
    .where(and(eq(products.id, post.productId), eq(products.workspaceId, workspaceId)));
  const [variant] = await db.select().from(variants).where(and(eq(variants.id, post.variantId), eq(variants.workspaceId, workspaceId)));
  const [item] = variant
    ? await db.select({ kind: contentItems.kind, status: contentItems.status }).from(contentItems).where(eq(contentItems.id, variant.contentItemId))
    : [];
  const mediaRows = variant?.assetIds.length
    ? await db
        .select()
        .from(assets)
        .where(and(inArray(assets.id, variant.assetIds), eq(assets.workspaceId, workspaceId)))
    : [];
  const byId = new Map(mediaRows.map((a) => [a.id, a]));
  const media = (variant?.assetIds ?? [])
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a, i) => ({ assetId: a.id, mime: a.mime, kind: a.kind, filename: downloadName(post.platform, i, a.mime), durationMs: a.durationMs }));
  const text = variant ? publishText(variant.body) : { text: "" };
  const tier = effectiveTier([variant?.provenanceTier ?? "A", ...mediaRows.map((a) => a.provenanceTier)]);

  const [conn] = post.connectionId
    ? await db
        .select()
        .from(socialConnections)
        .where(and(eq(socialConnections.id, post.connectionId), eq(socialConnections.workspaceId, workspaceId)))
    : [];

  let conflicts: string[] = [];
  if (PLANNED_STATES.includes(post.state)) {
    const cap = await loadCapContext(db, post);
    conflicts = checkCaps({ post, others: cap.others, connections: cap.connections, tz, mode: "plan" }).map((i) => i.message);
  }
  const [appr] = post.approvalId
    ? await db.select({ at: approvals.createdAt, voidedAt: approvals.voidedAt }).from(approvals).where(eq(approvals.id, post.approvalId))
    : [];

  const body = (variant?.body ?? {}) as Record<string, unknown>;
  const inner = (body.variant && typeof body.variant === "object" ? body.variant : body) as Record<string, unknown>;
  const promotional = !!inner.linkToken || URL_RE.test(text.text) || (text.parts ?? []).some((p) => URL_RE.test(p));

  return {
    id: post.id,
    productId: post.productId,
    productSlug: product?.slug ?? "",
    madeForKids: product?.madeForKids ?? null,
    platform: post.platform,
    state: post.state,
    mode: post.mode,
    scheduledAt: post.scheduledAt,
    slot: shortSlot(post.scheduledAt, tz),
    day: localDay(post.scheduledAt, tz),
    time: localTime(post.scheduledAt, tz),
    text,
    media,
    connection: conn ? { id: conn.id, handle: conn.handle, status: conn.status, publisher: conn.publisher } : null,
    canAutoPost: post.mode === "api" && !!conn && conn.status !== "revoked",
    platformOptions: post.platformOptions,
    lastError: post.lastError,
    staleReason: post.staleReason,
    platformUrl: post.platformUrl,
    conflicts,
    tier,
    contentKind: item?.kind ?? null,
    contentStatus: item?.status ?? null,
    promotional,
    approvedAt: appr && !appr.voidedAt ? appr.at : null,
  };
}

/** The approved final files of a post, for "Download & post yourself". Storage keys stay server-side. */
export async function postDownloadFiles(db: Db, workspaceId: string, postId: string) {
  const post = await loadPost(db, workspaceId, postId);
  if (!post) return null;
  const content = await currentContent(db, post);
  if (!content) return { post, files: [] as { name: string; mime: string; storageKey: string }[], text: null };
  return {
    post,
    text: content.text,
    files: content.media.map((m, i) => ({ name: downloadName(post.platform, i, m.mime), mime: m.mime, storageKey: m.storageKey })),
  };
}

/** Who to call for TikTok creator_info on this post. */
export async function postConnection(db: Db, workspaceId: string, postId: string) {
  const post = await loadPost(db, workspaceId, postId);
  if (!post?.connectionId) return null;
  const [conn] = await db
    .select()
    .from(socialConnections)
    .where(and(eq(socialConnections.id, post.connectionId), eq(socialConnections.workspaceId, workspaceId)));
  return conn ? { post, conn } : null;
}

// ── bulk counts for the Queue buttons ──

export interface ApprovalCounts {
  /** Pending API posts due in the next `days` days: "Approve next 7 days (14 posts)". */
  nextDays: number;
  /** Pending posts of final_ready videos: "Approve finished videos". */
  finishedVideos: number;
  /** Every post waiting for approval (Today card). */
  waiting: number;
  paused: number;
}

export async function approvalCounts(
  db: Db,
  workspaceId: string,
  opts: { productId?: string; days?: number; now?: Date } = {},
): Promise<ApprovalCounts> {
  const now = opts.now ?? new Date();
  const scope = opts.productId ? [eq(posts.productId, opts.productId)] : [];
  const until = new Date(now.getTime() + (opts.days ?? 7) * DAY_MS);
  const n = async (...where: Parameters<typeof and>) => {
    const [r] = await db
      .select({ n: count() })
      .from(posts)
      .where(and(eq(posts.workspaceId, workspaceId), ...scope, ...where));
    return Number(r?.n ?? 0);
  };
  const [nextDays, waiting, paused, videos] = await Promise.all([
    n(eq(posts.state, "pending_approval"), eq(posts.mode, "api"), gte(posts.scheduledAt, now), lte(posts.scheduledAt, until)),
    n(eq(posts.state, "pending_approval")),
    n(eq(posts.state, "paused")),
    finishedVideoPostIds(db, workspaceId, { ...opts, now }),
  ]);
  return { nextDays, finishedVideos: videos.length, waiting, paused };
}

// ── Copy & open ──

export interface AssistedCard {
  id: string;
  venue: string;
  title: string | null;
  body: string;
  due: string | null;
  rulesUrl: string | null;
  rulesSnapshot: string | null;
  /** "Sep 24" — when the rules summary was fetched. */
  rulesFetched: string | null;
  rulesCheckedToday: boolean;
  postingUrl: string | null;
  status: string;
}

export async function assistedCards(
  db: Db,
  workspaceId: string,
  opts: { productId?: string; dueBy?: Date; now?: Date } = {},
): Promise<AssistedCard[]> {
  const now = opts.now ?? new Date();
  const tz = await tzOf(db, workspaceId);
  const rows = await db
    .select()
    .from(assistedTasks)
    .where(
      and(
        eq(assistedTasks.workspaceId, workspaceId),
        eq(assistedTasks.status, "todo"),
        ...(opts.productId ? [eq(assistedTasks.productId, opts.productId)] : []),
        ...(opts.dueBy ? [or(isNull(assistedTasks.dueAt), lte(assistedTasks.dueAt, opts.dueBy))!] : []),
      ),
    )
    .orderBy(asc(assistedTasks.dueAt), asc(assistedTasks.createdAt));
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" });
  return rows.map((t) => ({
    id: t.id,
    venue: t.venue,
    title: t.title,
    body: t.body,
    due: t.dueAt ? shortSlot(t.dueAt, tz) : null,
    rulesUrl: t.rulesUrl,
    rulesSnapshot: t.rulesSnapshot,
    rulesFetched: t.rulesFetchedAt ? fmt.format(t.rulesFetchedAt) : null,
    rulesCheckedToday: rulesCheckedToday(t, now, tz),
    postingUrl: t.deepLink ?? assistedDeepLink(t.venue, { ...(t.title ? { title: t.title } : {}), text: t.body }),
    status: t.status,
  }));
}

// ── Today ──

export interface YesterdayNumbers {
  posts: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  linkClicks: number | null;
  signups: number | null;
}

const sumOf = (vals: (number | null | undefined)[]) => {
  const known = vals.filter((v): v is number => typeof v === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/**
 * Posts that went out yesterday (workspace day) with each one's latest snapshot, plus
 * yesterday's first-party signups. Null metrics stay unknown; nothing is estimated.
 */
export async function yesterdayNumbers(db: Db, workspaceId: string, productId: string, now = new Date()): Promise<YesterdayNumbers | null> {
  const tz = await tzOf(db, workspaceId);
  const day = addDays(localDay(now, tz), -1);
  const { from, to } = dayBounds(day, tz);
  const published = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(eq(posts.workspaceId, workspaceId), eq(posts.productId, productId), eq(posts.state, "published"), gte(posts.publishedAt, from), lt(posts.publishedAt, to)),
    );
  const [conv] = await db
    .select({ signups: conversionSnapshots.signups })
    .from(conversionSnapshots)
    .where(and(eq(conversionSnapshots.workspaceId, workspaceId), eq(conversionSnapshots.productId, productId), eq(conversionSnapshots.day, day)));
  if (!published.length && !conv) return null;
  const snaps = published.length
    ? await db
        .select()
        .from(analyticsSnapshots)
        .where(
          and(
            eq(analyticsSnapshots.workspaceId, workspaceId),
            inArray(
              analyticsSnapshots.postId,
              published.map((p) => p.id),
            ),
          ),
        )
        .orderBy(desc(analyticsSnapshots.ageHours))
    : [];
  const latest = new Map<string, Record<string, number | null>>();
  for (const s of snaps) if (!latest.has(s.postId)) latest.set(s.postId, s.metrics);
  const m = [...latest.values()];
  return {
    posts: published.length,
    views: sumOf(m.map((x) => x.views)),
    likes: sumOf(m.map((x) => x.likes)),
    comments: sumOf(m.map((x) => x.comments)),
    linkClicks: sumOf(m.map((x) => x.linkClicks)),
    signups: conv ? conv.signups : null,
  };
}

// ── webhooks (§5.8 step 4) ──

const KEY = /^pst_([0-9a-f-]{36})_g(\d+)$/i;

/**
 * Webhooks aren't workspace-scoped: before the signature is checked, find which workspace's
 * secret to try from the (unverified) body. Only used to pick a key; nothing is trusted from it.
 */
export async function webhookWorkspaceHint(db: Db, rawBody: string): Promise<string | null> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object") return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const externalId = s(body.external_id);
  if (externalId) {
    const [p] = await db.select({ ws: posts.workspaceId }).from(posts).where(eq(posts.idempotencyKey, externalId));
    if (p) return p.ws;
    const m = KEY.exec(externalId);
    if (m) {
      const [byId] = await db.select({ ws: posts.workspaceId }).from(posts).where(eq(posts.id, m[1]!.toLowerCase()));
      if (byId) return byId.ws;
    }
  }
  const requestId = s(body.request_id) ?? s(body.job_id);
  if (requestId) {
    const [p] = await db
      .select({ ws: posts.workspaceId })
      .from(posts)
      .where(or(eq(posts.providerRequestId, requestId), eq(posts.providerRequestId, `job:${requestId}`)));
    if (p) return p.ws;
  }
  const profile = s(body.profile_username);
  if (profile) {
    const [c] = await db.select({ ws: socialConnections.workspaceId }).from(socialConnections).where(eq(socialConnections.profileRef, profile)).limit(1);
    if (c) return c.ws;
  }
  return null;
}

/** Store a verified webhook once (unique provider + event id). A repeat of an unprocessed row is re-offered for enqueueing. */
export async function storeWebhookEvent(
  db: Db,
  row: { provider: string; eventId: string; type: string; body: string; workspaceId: string | null },
): Promise<{ id: string; duplicate: boolean; processed: boolean }> {
  const id = uuidv7();
  const inserted = await db
    .insert(webhookEvents)
    .values({ id, provider: row.provider, eventId: row.eventId, type: row.type, body: row.body, workspaceId: row.workspaceId })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] })
    .returning({ id: webhookEvents.id });
  if (inserted.length) return { id, duplicate: false, processed: false };
  const [existing] = await db
    .select({ id: webhookEvents.id, processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, row.provider), eq(webhookEvents.eventId, row.eventId)));
  return { id: existing!.id, duplicate: true, processed: !!existing!.processedAt };
}
