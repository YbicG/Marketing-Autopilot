import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { parsePlatformOptions } from "@mkt/contracts";
import {
  isAssistedOnly,
  publisher,
  type Platform,
  type PostType,
  type ProviderCtx,
  type PublisherAdapter,
  type PublishMedia,
  type PublishRequest,
  type PublishStatus,
} from "@mkt/providers";
import { approvalMatches } from "./approvals.ts";
import { checkCaps, loadCapContext } from "./caps.ts";
import { contentProblems } from "./claims.ts";
import { recordTrackedLinks, resolveLinkTokens, buildUtm } from "./links.ts";
import { aiDisclosureFor, effectiveTier, withCaptionLabel, type Tier } from "./provenance.ts";
import { scheduleEffects, type EffectDeps, type JobGateway } from "./scheduler.ts";
import type { PostEvent, TransitionCtx } from "./state-machine.ts";
import { applyEvent, applyEvents, currentContent, loadPost, type Actor, type PostRow } from "./store.ts";
import { validateTikTokComposer } from "./tiktok.ts";

const { campaigns, contentItems, posts, products, socialConnections, workspaces } = schema;

const WORKER: Actor = { type: "worker" };

export interface PublishDeps {
  db: Db;
  gateway: JobGateway;
  /** MISSED_SLOT_GRACE_MIN (D3). */
  graceMin: number;
  now?: () => Date;
  /** Defaults to the provider registry (`publisher(id)`); tests pass a fake. */
  adapterFor?: (publisherId: string) => PublisherAdapter;
  /** Secrets resolved vault-first then env (D19); injected so core never reads keys itself. */
  ctxFor: (workspaceId: string) => ProviderCtx;
  /** Reads the approved final file from storage (R2 mkt-private from M2). */
  openMedia: (asset: { workspaceId: string; storageKey: string }) => Promise<Uint8Array>;
  scheduleAnalytics?: EffectDeps["scheduleAnalytics"];
  notify?: EffectDeps["notify"];
  /** How long submit may take before the post becomes `unknown` (never re-sent until lookup says absent). */
  submitTimeoutMs?: number;
}

export type DueOutcome =
  | "gone"
  | "stale_job"
  | "missed"
  | "pending_approval"
  | "failed"
  | "submitted"
  | "published"
  | "unknown"
  | "awaiting_user";

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();
export const ctxOf = (deps: { now?: () => Date; graceMin: number }): TransitionCtx => ({ now: nowOf(deps), graceMin: deps.graceMin });
const adapterOf = (deps: PublishDeps, id: string) => (deps.adapterFor ?? publisher)(id);

export function effectDeps(deps: Pick<PublishDeps, "gateway" | "scheduleAnalytics" | "notify">): EffectDeps {
  return { gateway: deps.gateway, scheduleAnalytics: deps.scheduleAnalytics, notify: deps.notify };
}

/** Apply events in one transaction, then run the queue effects. */
export async function commitEvents(
  deps: Pick<PublishDeps, "db" | "gateway" | "scheduleAnalytics" | "notify">,
  post: PostRow,
  events: PostEvent[],
  ctx: TransitionCtx,
  actor: Actor,
  opts: { data?: Record<string, unknown>; set?: Partial<PostRow> } = {},
): Promise<PostRow> {
  const r = await deps.db.transaction(async (tx) => {
    let cur = post;
    if (opts.set && Object.keys(opts.set).length) {
      const [row] = await tx.update(posts).set(opts.set).where(eq(posts.id, post.id)).returning();
      cur = row!;
    }
    return applyEvents(tx, cur, events, ctx, actor, opts.data);
  });
  await scheduleEffects(effectDeps(deps), post.id, r.effects);
  return r.post;
}

class MediaChanged extends Error {}

export function postTypeFor(kind: string | undefined, media: { mime: string }[]): PostType {
  if (kind === "thread") return "thread";
  if (media.some((m) => m.mime.startsWith("video/"))) return "video";
  if (media.some((m) => m.mime === "application/pdf")) return "document";
  if (kind === "carousel" || media.length > 1) return "carousel";
  if (media.length === 1) return "image";
  return "text";
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};

type Prepared =
  | { kind: "invalid"; reason: string }
  | { kind: "blocked"; reason: string }
  | {
      kind: "ready";
      adapter: PublisherAdapter;
      request: PublishRequest;
      warnings: string[];
      drafts: boolean;
      aiDisclosure: Record<string, unknown>;
      trackedLinks: { token: string; url: string }[];
      utm: Record<string, string>;
    };

/** §5.8 step 2, everything before the one upload. Pure reads: no state change, nothing sent. */
async function prepare(deps: PublishDeps, post: PostRow, ctx: TransitionCtx): Promise<Prepared> {
  const { db } = deps;
  if (isAssistedOnly(post.platform) || post.mode !== "api") {
    return { kind: "blocked", reason: "This venue is post-it-yourself only. Use Copy & open." };
  }

  const content = await currentContent(db, post);
  if (!content) return { kind: "invalid", reason: "This post's text or media is missing." };
  const appr = await approvalMatches(db, post, content.hash);
  if (!appr.ok) return { kind: "invalid", reason: appr.reason };

  const problems = await contentProblems(db, post.variantId, { scheduledAt: post.scheduledAt, now: ctx.now });
  if (problems.length) return { kind: "invalid", reason: problems.join(" ") };

  if (!post.connectionId) return { kind: "blocked", reason: `Connect a ${post.platform} account to post this.` };
  const [conn] = await db
    .select()
    .from(socialConnections)
    .where(and(eq(socialConnections.id, post.connectionId), eq(socialConnections.workspaceId, post.workspaceId)));
  if (!conn) return { kind: "blocked", reason: `Connect a ${post.platform} account to post this.` };
  if (conn.status !== "active") return { kind: "blocked", reason: `Reconnect your ${post.platform} account, then reschedule this post.` };

  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, post.workspaceId));
  const tz = ws?.tz ?? "UTC";
  const capCtx = await loadCapContext(db, post);
  const capIssues = checkCaps({ post, others: capCtx.others, connections: capCtx.connections, tz, mode: "prepare" });
  if (capIssues.length) return { kind: "blocked", reason: capIssues.map((i) => i.message).join(" ") };

  const parsed = parsePlatformOptions(post.platform, post.platformOptions);
  if (!parsed.success) return { kind: "invalid", reason: parsed.error.issues.map((i) => i.message).join(" ") };
  const options = parsed.data;

  const adapter = adapterOf(deps, conn.publisher);
  if (!adapter.platforms.includes(post.platform as Platform)) {
    return { kind: "blocked", reason: `${post.platform} can't be posted through this service.` };
  }
  const providerCtx = deps.ctxFor(post.workspaceId);
  const caps = adapter.caps(post.platform as Platform);
  const warnings: string[] = [];

  const [meta] = await db
    .select({ kind: contentItems.kind, angleId: contentItems.angleId, campaignId: campaigns.id, slug: products.slug, website: products.urls })
    .from(contentItems)
    .innerJoin(campaigns, eq(campaigns.id, contentItems.campaignId))
    .innerJoin(products, eq(products.id, campaigns.productId))
    .where(eq(contentItems.id, content.variant.contentItemId));
  if (!meta) return { kind: "invalid", reason: "This post's content is missing." };

  let drafts = false;
  if (post.platform === "tiktok") {
    let creatorInfo = null;
    try {
      creatorInfo = await adapter.creatorInfo(providerCtx, conn.profileRef, "tiktok");
    } catch {
      warnings.push("Couldn't read TikTok's account settings; posting with the options you approved.");
    }
    const pendingDrafts = (
      await db
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.connectionId, conn.id), eq(posts.state, "awaiting_user")))
    ).length;
    const videoMs = Math.max(0, ...content.media.map((m) => m.durationMs ?? 0));
    const tt = validateTikTokComposer({
      options,
      creatorInfo,
      pendingDrafts,
      ...(videoMs ? { videoSeconds: videoMs / 1000 } : {}),
    });
    const blocks = tt.issues.filter((i) => i.severity === "block");
    if (blocks.length) return { kind: "blocked", reason: blocks.map((i) => i.message).join(" ") };
    drafts = tt.mode === "drafts";
  }

  const utm = buildUtm({
    platform: post.platform,
    productSlug: meta.slug,
    campaignId: meta.campaignId,
    variantId: content.variant.id,
    angleId: meta.angleId,
  });
  const resolve = (t: string) =>
    resolveLinkTokens(t, {
      landingUrl: meta.website.website ?? null,
      utm,
      links: caps.links,
      linksAllowed: conn.capabilities.linksAddon === true,
    });
  const main = resolve(content.text.text);
  const parts = content.text.parts?.map(resolve);
  const allProblems = [...main.problems, ...(parts?.flatMap((p) => p.problems) ?? [])];
  if (allProblems.length) return { kind: "blocked", reason: [...new Set(allProblems)].join(" ") };
  warnings.push(...main.warnings);

  const tier = effectiveTier([content.variant.provenanceTier as Tier, ...content.media.map((m) => m.provenanceTier as Tier)]);
  const disclosure = aiDisclosureFor(post.platform, tier, caps.aiFlags, options.markAsAi === true || options.containsSyntheticMedia === true);
  if (disclosure.blocked) return { kind: "blocked", reason: disclosure.blocked };

  const text = withCaptionLabel(
    parts?.length ? parts.map((p) => p.text).join("\n\n") : main.text,
    disclosure.captionLabel,
  );
  const threadParts = parts?.length ? parts.map((p, i) => (i === parts.length - 1 ? withCaptionLabel(p.text, disclosure.captionLabel) : p.text)) : null;
  const tooLong = threadParts ? threadParts.find((p) => p.length > caps.maxCaptionChars) : text.length > caps.maxCaptionChars ? text : null;
  if (tooLong && post.platform !== "x") {
    return { kind: "blocked", reason: `This post is ${tooLong.length} characters; ${post.platform} allows ${caps.maxCaptionChars}.` };
  }

  const media: PublishMedia[] = content.media.map((m) => ({
    assetId: m.id,
    sha256: m.sha256,
    mime: m.mime,
    filename: `${m.id}.${EXT[m.mime] ?? "bin"}`,
    // The file must still be the one approved: the hash covers the final media (§8 first row).
    open: async () => {
      const bytes = await deps.openMedia({ workspaceId: m.workspaceId, storageKey: m.storageKey });
      if (createHash("sha256").update(bytes).digest("hex") !== m.sha256) throw new MediaChanged("media changed after approval");
      return bytes;
    },
  }));

  const title = content.text.title ?? (typeof options.title === "string" ? options.title : undefined);
  const firstComment = content.text.firstComment ?? (typeof options.firstComment === "string" ? options.firstComment : undefined);
  const request: PublishRequest = {
    externalId: post.idempotencyKey,
    profileRef: conn.profileRef,
    platform: post.platform as Platform,
    postType: postTypeFor(meta.kind, content.media),
    text,
    ...(title ? { title } : {}),
    ...(firstComment ? { firstComment } : {}),
    media,
    // Threads: every part, links resolved (PublishRequest has no parts field; `text` joins them as a fallback).
    options: threadParts ? { ...options, threadParts } : options,
    aiFlags: disclosure.flags,
  };

  const issues = adapter.validate(request);
  const blocks = issues.filter((i) => i.severity === "block");
  if (blocks.length) return { kind: "blocked", reason: blocks.map((i) => i.message).join(" ") };
  warnings.push(...issues.filter((i) => i.severity === "warn").map((i) => i.message));

  return {
    kind: "ready",
    adapter,
    request,
    warnings,
    drafts,
    aiDisclosure: { tier, flags: disclosure.flags, captionLabel: disclosure.captionLabel },
    trackedLinks: [...main.links, ...(parts?.flatMap((p) => p.links) ?? [])],
    utm,
  };
}

/** How one upload answer maps onto the machine. A retryable failure may still have landed: treat it as no answer. */
export function submitEvents(status: PublishStatus, drafts: boolean): PostEvent[] {
  switch (status.state) {
    case "accepted":
      return [{ type: "accepted", requestId: status.requestId }, ...(drafts ? [{ type: "drafts_mode" } as const] : [])];
    case "pending":
      return [{ type: "accepted", ...(status.requestId ? { requestId: status.requestId } : {}) }, ...(drafts ? [{ type: "drafts_mode" } as const] : [])];
    case "published":
      return [{ type: "published", url: status.url, providerPostId: status.postId, requestId: status.requestId }];
    case "awaiting_user":
      return [{ type: "drafts_mode", reason: status.reason }];
    case "failed":
      return status.retryable ? [{ type: "no_response", reason: status.reason }] : [{ type: "failed", reason: status.reason }];
  }
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([run(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * publish.due (§5.8 steps 2–3). Missed-slot check, prepare, then submit exactly once: the post is
 * committed as `submitting` BEFORE the upload call, so a crash, timeout or 5xx leaves it `unknown`
 * and only reconcile's lookup by external_id may ever send it again.
 */
export async function handlePublishDue(deps: PublishDeps, data: { postId: string; generation: number }): Promise<DueOutcome> {
  let post = await loadPost(deps.db, null, data.postId);
  if (!post) return "gone";
  if (post.generation !== data.generation || post.state !== "queued") return "stale_job";

  post = await commitEvents(deps, post, [{ type: "due" }], ctxOf(deps), WORKER);
  if (post.state === "missed") return "missed";

  let prep: Prepared;
  try {
    prep = await prepare(deps, post, ctxOf(deps));
  } catch (err) {
    prep = { kind: "blocked", reason: `Something went wrong getting this post ready (${(err as Error).message}). Reschedule it to try again.` };
  }
  if (prep.kind === "invalid") {
    post = await commitEvents(deps, post, [{ type: "prepare_invalid", reason: prep.reason }], ctxOf(deps), WORKER);
    return "pending_approval";
  }
  if (prep.kind === "blocked") {
    post = await commitEvents(deps, post, [{ type: "prepare_blocked", reason: prep.reason }], ctxOf(deps), WORKER);
    return "failed";
  }

  const ready = prep;
  // Commit `submitting` (and the tracking links) before the one upload call.
  post = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(posts)
      .set({ aiDisclosure: ready.aiDisclosure })
      .where(eq(posts.id, post!.id))
      .returning();
    await recordTrackedLinks(tx, { workspaceId: row!.workspaceId, productId: row!.productId, variantId: row!.variantId, utm: ready.utm }, ready.trackedLinks);
    const r = await applyEvent(tx, row!, { type: "prepared" }, ctxOf(deps), WORKER, ready.warnings.length ? { warnings: ready.warnings } : undefined);
    return r.post;
  });

  let events: PostEvent[];
  try {
    const status = await withTimeout(deps.submitTimeoutMs ?? 120_000, (signal) =>
      ready.adapter.submit({ ...deps.ctxFor(post!.workspaceId), signal }, ready.request),
    );
    events = submitEvents(status, ready.drafts);
  } catch (err) {
    events =
      err instanceof MediaChanged
        ? [{ type: "failed", reason: "The file changed after you approved it. Approve it again." }]
        : [{ type: "no_response", reason: `No answer from the posting service (${(err as Error).message}).` }];
  }
  post = await commitEvents(deps, post, events, ctxOf(deps), WORKER);
  return post.state as DueOutcome;
}

