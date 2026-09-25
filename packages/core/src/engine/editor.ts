import { and, desc, eq, gte, inArray, lte, ne, notInArray } from "drizzle-orm";
import {
  CarouselSpec,
  CarouselVariantBody,
  PLATFORM_LIMITS,
  TextVariantBody,
  countChars,
  findJargon,
  textLimit,
  type CampaignPlan,
  type CarouselCaption,
  type CarouselSlide,
  type ItemBrief,
  type PostFormat,
  type PostVariant,
  type SocialPlatform,
} from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { brandFor } from "../video/context.ts";
import { bundleById } from "./bundle.ts";
import { variantContentHash } from "./hash.ts";
import { variantText } from "./package.ts";
import { slideChecks, slideColors, type SlideCheck, type SlideColors } from "./slide-checks.ts";
import {
  SIMILARITY_WINDOW_DAYS,
  hasBlock,
  sanitizeVariant,
  validateCarousel,
  validateVariant,
  type ClaimInfo,
  type CopyIssue,
  type ValidateContext,
} from "./validate.ts";

const { campaigns, contentItems, variants, posts, claims, assets, generationRuns } = schema;

// Post editor and swipe post editor (§2.3): loaders and saves. Saves only write the variant; the
// web route then calls publishing's onVariantChanged (approved posts drop back to pending, D9) and
// applyEffects, then syncDraftStates so posts with a blocking check sit in draft.

/** Post states whose variant may still be edited (publishing editPost's list, plus canceled). */
export const EDITABLE_POST_STATES = ["draft", "pending_approval", "approved", "queued", "paused", "missed", "failed", "canceled"] as const;

type ItemRow = typeof contentItems.$inferSelect;
type VariantRow = typeof variants.$inferSelect;
type PostRow = typeof posts.$inferSelect;

export interface EditorPost {
  id: string;
  state: PostRow["state"];
  scheduledAt: string;
  connected: boolean;
}

export interface ClaimChip {
  ref: string;
  text: string;
  publicOk: boolean;
  status: string;
}

interface Loaded {
  item: ItemRow;
  campaign: typeof campaigns.$inferSelect;
  plan: CampaignPlan | null;
  brief: ItemBrief | null;
  claims: Map<string, ClaimInfo & { text: string }>;
  variants: VariantRow[];
  posts: PostRow[];
}

async function loadItem(db: Db, workspaceId: string, contentItemId: string): Promise<Loaded | null> {
  const [item] = await db.select().from(contentItems).where(and(eq(contentItems.id, contentItemId), eq(contentItems.workspaceId, workspaceId)));
  if (!item) return null;
  const [campaign] = await db.select().from(campaigns).where(and(eq(campaigns.id, item.campaignId), eq(campaigns.workspaceId, workspaceId)));
  if (!campaign) return null;
  const bundle = campaign.bundleId ? await bundleById(db, workspaceId, campaign.bundleId) : null;
  const claimRows = bundle ? await db.select().from(claims).where(and(eq(claims.dnaVersionId, bundle.dnaVersionId), eq(claims.workspaceId, workspaceId))) : [];
  const vs = await db.select().from(variants).where(and(eq(variants.contentItemId, item.id), eq(variants.workspaceId, workspaceId))).orderBy(variants.createdAt);
  const ps = vs.length ? await db.select().from(posts).where(and(eq(posts.workspaceId, workspaceId), inArray(posts.variantId, vs.map((v) => v.id)))) : [];
  return {
    item,
    campaign,
    plan: (campaign.plan as unknown as CampaignPlan | null) ?? null,
    brief: (item.brief as unknown as ItemBrief | null) ?? null,
    claims: new Map(claimRows.map((c) => [c.ref, { ref: c.ref, publicOk: c.publicOk, status: c.status, expiresAt: c.expiresAt, text: c.text }])),
    variants: vs,
    posts: ps,
  };
}

/** Other posts on the same connection (or platform + product when unconnected) within ±14 days. */
async function recentTexts(db: Db, workspaceId: string, productId: string, platform: string, connectionId: string | null, at: Date, excludeItemId: string) {
  const win = SIMILARITY_WINDOW_DAYS * 86_400_000;
  const rows = await db
    .select({ body: variants.body })
    .from(posts)
    .innerJoin(variants, eq(variants.id, posts.variantId))
    .where(
      and(
        eq(posts.workspaceId, workspaceId),
        connectionId ? eq(posts.connectionId, connectionId) : and(eq(posts.productId, productId), eq(posts.platform, platform)),
        ne(variants.contentItemId, excludeItemId),
        notInArray(posts.state, ["canceled"]),
        gte(posts.scheduledAt, new Date(at.getTime() - win)),
        lte(posts.scheduledAt, new Date(at.getTime() + win)),
      ),
    );
  return rows.map((r) => variantText(r.body)).filter(Boolean);
}

function formatFor(l: Loaded, platform: string): PostFormat {
  return l.brief?.targets.find((t) => t.platform === platform)?.format ?? "text";
}

async function contextFor(db: Db, l: Loaded, v: VariantRow): Promise<ValidateContext> {
  const platform = v.platform as SocialPlatform;
  const post = l.posts.find((p) => p.variantId === v.id && p.state !== "canceled") ?? null;
  const at = post?.scheduledAt ?? null;
  const slot = l.plan?.slots.find((s) => (l.brief?.slotIds ?? []).includes(s.id) && s.platform === platform) ?? null;
  return {
    platform,
    format: formatFor(l, platform),
    scheduledAt: at,
    claims: l.claims,
    recentTexts: at ? await recentTexts(db, l.item.workspaceId, l.campaign.productId, platform, post?.connectionId ?? slot?.connectionId ?? null, at, l.item.id) : [],
    xLinksAllowed: !!slot && !!l.plan && Math.abs(slot.day - l.plan.launchDay) <= 3,
  };
}

function lockReason(ps: PostRow[]): string | null {
  const locked = ps.find((p) => !(EDITABLE_POST_STATES as readonly string[]).includes(p.state));
  if (!locked) return null;
  return locked.state === "published" ? "This one is already posted." : "This one is posting right now, so it can't be changed.";
}

const editorPosts = (ps: PostRow[], variantId: string): EditorPost[] =>
  ps
    .filter((p) => p.variantId === variantId)
    .map((p) => ({ id: p.id, state: p.state, scheduledAt: p.scheduledAt.toISOString(), connected: !!p.connectionId }));

// ── bio / pinned checks ──

export function validateProfileText(kind: "bio" | "pinned", platform: SocialPlatform, text: string): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const l = PLATFORM_LIMITS[platform];
  const limit = kind === "bio" ? l.bio : l.text;
  if (!text.trim()) issues.push({ code: "empty", severity: "block", message: "It's empty." });
  const n = countChars(platform, text);
  if (n > limit) issues.push({ code: "too_long", severity: "block", message: `It's ${n} characters; ${l.label} allows ${limit}${kind === "bio" ? " in a bio" : ""}.` });
  const jargon = findJargon(text, "post");
  if (jargon.length) issues.push({ code: "jargon", severity: "warn", message: `Marketing jargon: ${[...new Set(jargon.map((j) => j.term))].join(", ")}.` });
  return issues;
}

// ── post editor ──

export interface PostEditorVariant {
  id: string;
  platform: SocialPlatform;
  platformLabel: string;
  format: PostFormat;
  kind: "post" | "thread" | "bio" | "pinned";
  /** Character limit per part (bio limit for bios). */
  limit: number;
  text: string;
  parts: string[];
  hashtags: string[];
  firstComment: string | null;
  altText: string | null;
  claimRefs: string[];
  issues: CopyIssue[];
  posts: EditorPost[];
  lockedReason: string | null;
  lastRewrite: { runId: string; status: string; message: string | null } | null;
}

export interface PostEditorView {
  contentItemId: string;
  campaignId: string;
  kind: ItemRow["kind"];
  status: ItemRow["status"];
  needsYouReason: string | null;
  day: number | null;
  costMicros: number;
  angleIdx: number | null;
  variants: PostEditorVariant[];
  claims: ClaimChip[];
}

async function lastRewrites(db: Db, workspaceId: string, productId: string, variantIds: string[]) {
  if (!variantIds.length) return new Map<string, PostEditorVariant["lastRewrite"]>();
  const rows = await db
    .select({ id: generationRuns.id, status: generationRuns.status, input: generationRuns.input, result: generationRuns.result })
    .from(generationRuns)
    .where(and(eq(generationRuns.workspaceId, workspaceId), eq(generationRuns.productId, productId), eq(generationRuns.kind, "refill")))
    .orderBy(desc(generationRuns.createdAt))
    .limit(100);
  const out = new Map<string, PostEditorVariant["lastRewrite"]>();
  for (const r of rows) {
    const vid = r.input.action === "rewrite" && typeof r.input.variantId === "string" ? r.input.variantId : null;
    if (!vid || !variantIds.includes(vid) || out.has(vid)) continue;
    out.set(vid, { runId: r.id, status: r.status, message: typeof r.result?.message === "string" ? r.result.message : null });
  }
  return out;
}

/** Post editor: every platform variant of a post / thread / bio / pinned item, freshly checked. */
export async function postEditorView(db: Db, workspaceId: string, contentItemId: string): Promise<PostEditorView | null> {
  const l = await loadItem(db, workspaceId, contentItemId);
  if (!l || !["post", "thread", "bio", "pinned"].includes(l.item.kind)) return null;
  const rewrites = await lastRewrites(db, workspaceId, l.campaign.productId, l.variants.map((v) => v.id));
  const out: PostEditorVariant[] = [];
  const refs = new Set<string>();
  for (const v of l.variants) {
    const platform = v.platform as SocialPlatform;
    if (!PLATFORM_LIMITS[platform]) continue;
    const common = {
      id: v.id,
      platform,
      platformLabel: PLATFORM_LIMITS[platform].label,
      format: formatFor(l, platform),
      posts: editorPosts(l.posts, v.id),
      lockedReason: lockReason(l.posts.filter((p) => p.variantId === v.id)),
      lastRewrite: rewrites.get(v.id) ?? null,
    };
    const text = TextVariantBody.safeParse(v.body);
    if (text.success) {
      const pv = text.data.variant;
      pv.claimRefs.forEach((r) => refs.add(r));
      out.push({
        ...common,
        kind: text.data.kind,
        limit: textLimit(platform, common.format),
        text: pv.text,
        parts: pv.parts,
        hashtags: pv.hashtags,
        firstComment: pv.firstComment,
        altText: pv.altText,
        claimRefs: pv.claimRefs,
        issues: validateVariant(pv, await contextFor(db, l, v)),
      });
      continue;
    }
    const kind = l.item.kind === "pinned" ? "pinned" : "bio";
    const t = typeof v.body.text === "string" ? v.body.text : "";
    const stored = (v.qa as { issues?: CopyIssue[] } | null)?.issues ?? [];
    out.push({
      ...common,
      kind,
      limit: kind === "bio" ? PLATFORM_LIMITS[platform].bio : PLATFORM_LIMITS[platform].text,
      text: t,
      parts: [],
      hashtags: [],
      firstComment: null,
      altText: null,
      claimRefs: [],
      issues: Object.keys(v.body).length ? validateProfileText(kind, platform, t) : stored,
    });
  }
  return {
    contentItemId: l.item.id,
    campaignId: l.campaign.id,
    kind: l.item.kind,
    status: l.item.status,
    needsYouReason: l.item.needsYouReason,
    day: l.item.day,
    costMicros: l.item.costMicros,
    angleIdx: l.brief?.angleIdx ?? null,
    variants: out,
    claims: [...refs].map((ref) => {
      const c = l.claims.get(ref);
      return { ref, text: c?.text ?? "A fact we don't have", publicOk: c?.publicOk ?? false, status: c?.status ?? "missing" };
    }),
  };
}

export interface TextEdit {
  text: string;
  /** Threads: every part in order (text is ignored and becomes parts[0]). */
  parts?: string[];
  hashtags?: string[];
  firstComment?: string | null;
  altText?: string | null;
}

export type SaveResult =
  | { ok: true; variantId: string; contentItemId: string; issues: CopyIssue[]; changed: boolean }
  | { ok: false; status: 404 | 409 | 400; message: string };

/**
 * Save the text of one variant: sanitize (raw links out), re-check, write body + qa + content hash,
 * and refresh the item's status. Returns `changed` so the route knows to void approvals.
 */
export async function saveTextVariant(db: Db, workspaceId: string, variantId: string, edit: TextEdit, now = new Date()): Promise<SaveResult> {
  const [v] = await db.select().from(variants).where(and(eq(variants.id, variantId), eq(variants.workspaceId, workspaceId)));
  if (!v) return { ok: false, status: 404, message: "That post wasn't found." };
  const l = await loadItem(db, workspaceId, v.contentItemId);
  if (!l) return { ok: false, status: 404, message: "That post wasn't found." };
  const locked = lockReason(l.posts.filter((p) => p.variantId === v.id));
  if (locked) return { ok: false, status: 409, message: locked };
  const platform = v.platform as SocialPlatform;
  if (!PLATFORM_LIMITS[platform]) return { ok: false, status: 400, message: "This platform can't be edited here." };

  let body: Record<string, unknown>;
  let issues: CopyIssue[];
  const parsed = TextVariantBody.safeParse(v.body);
  if (parsed.success) {
    const cur = parsed.data.variant;
    const parts = parsed.data.kind === "thread" ? (edit.parts ?? cur.parts).map((p) => p.trim()).filter(Boolean) : [];
    const text = (parts[0] ?? edit.text).trim();
    if (!text) return { ok: false, status: 400, message: "The post can't be empty." };
    const next: PostVariant = {
      ...cur,
      text,
      parts,
      hashtags: edit.hashtags ?? cur.hashtags,
      firstComment: edit.firstComment === undefined ? cur.firstComment : edit.firstComment?.trim() || null,
      altText: edit.altText === undefined ? cur.altText : edit.altText?.trim() || null,
    };
    const ctx = await contextFor(db, l, v);
    const s = sanitizeVariant(next, ctx);
    issues = [...s.issues, ...validateVariant(s.variant, ctx)];
    body = { ...parsed.data, variant: s.variant };
  } else if (l.item.kind === "bio" || l.item.kind === "pinned") {
    const text = edit.text.trim();
    issues = validateProfileText(l.item.kind, platform, text);
    body = { schemaVersion: 1, kind: l.item.kind, text };
  } else {
    return { ok: false, status: 400, message: "This one isn't a text post." };
  }

  const contentHash = variantContentHash({ platform, body });
  const changed = contentHash !== v.contentHash;
  await db
    .update(variants)
    .set({ body, qa: { issues, checkedAt: now.toISOString(), editedAt: now.toISOString() }, contentHash, updatedAt: now })
    .where(and(eq(variants.id, v.id), eq(variants.workspaceId, workspaceId)));
  await refreshItemStatus(db, workspaceId, l.item.id, now);
  return { ok: true, variantId: v.id, contentItemId: l.item.id, issues, changed };
}

/**
 * After an edit (and after onVariantChanged): posts of a variant with a blocking check sit in draft;
 * once it passes they are pending_approval again. Never touches approved or later states.
 */
export async function syncDraftStates(db: Db, workspaceId: string, variantId: string, now = new Date()): Promise<void> {
  const [v] = await db.select({ qa: variants.qa }).from(variants).where(and(eq(variants.id, variantId), eq(variants.workspaceId, workspaceId)));
  if (!v) return;
  const blocked = hasBlock((v.qa as { issues?: CopyIssue[] } | null)?.issues ?? []);
  await db
    .update(posts)
    .set({ state: blocked ? "draft" : "pending_approval", updatedAt: now })
    .where(and(eq(posts.workspaceId, workspaceId), eq(posts.variantId, variantId), eq(posts.state, blocked ? "pending_approval" : "draft")));
}

/** ready ⇄ needs_you from the variants' checks. Items in other states (generating, approved…) stay put. */
async function refreshItemStatus(db: Db, workspaceId: string, contentItemId: string, now: Date) {
  const [item] = await db.select().from(contentItems).where(and(eq(contentItems.id, contentItemId), eq(contentItems.workspaceId, workspaceId)));
  if (!item || !["ready", "needs_you", "failed"].includes(item.status)) return;
  const vs = await db.select({ qa: variants.qa }).from(variants).where(eq(variants.contentItemId, item.id));
  const block = vs.flatMap((v) => (v.qa as { issues?: CopyIssue[] } | null)?.issues ?? []).find((i) => i.severity === "block");
  await db
    .update(contentItems)
    .set({ status: block ? "needs_you" : "ready", needsYouReason: block ? block.message : null, updatedAt: now })
    .where(eq(contentItems.id, item.id));
}

// ── swipe post editor ──

export interface CarouselOutput {
  platform: SocialPlatform;
  label: string;
  /** e.g. "JPEG 1080×1350, up to 10 slides". */
  description: string;
}

/** §5.5 outputs per platform (mirrors core/video stills.ts STILL_OUTPUT). */
export function carouselOutput(platform: SocialPlatform): CarouselOutput {
  const label = PLATFORM_LIMITS[platform].label;
  switch (platform) {
    case "instagram":
      return { platform, label, description: "JPEG 1080×1350, up to 10 slides" };
    case "tiktok":
      return { platform, label, description: "Photo post 1080×1920, with music added by TikTok" };
    case "linkedin":
      return { platform, label, description: "PDF document, 1080×1350 pages" };
    case "x":
      return { platform, label, description: "4 images, 1600×900" };
    default:
      return { platform, label, description: "Images, 1080×1350" };
  }
}

export interface CarouselEditorVariant {
  id: string;
  platform: SocialPlatform;
  output: CarouselOutput;
  caption: CarouselCaption;
  captionLimit: number;
  renderedAssetIds: string[];
  /** True when the images are older than the last text change (a render is queued or due). */
  rendering: boolean;
  issues: CopyIssue[];
  posts: EditorPost[];
  lockedReason: string | null;
}

export interface CarouselEditorView {
  contentItemId: string;
  campaignId: string;
  status: ItemRow["status"];
  needsYouReason: string | null;
  day: number | null;
  costMicros: number;
  slides: CarouselSlide[];
  slideChecks: SlideCheck[][];
  colors: SlideColors;
  altText: string | null;
  claimRefs: string[];
  claims: ClaimChip[];
  variants: CarouselEditorVariant[];
  screenshots: { id: string; caption: string }[];
}

async function screenshotsFor(db: Db, workspaceId: string, productId: string) {
  const rows = await db
    .select({ id: assets.id, kind: assets.kind, labels: assets.labels, piiHits: assets.piiHits })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), eq(assets.productId, productId), eq(assets.kind, "screenshot")));
  return rows
    .filter((a) => {
      const l = a.labels as { usefulForMarketing?: boolean; hasPersonalData?: boolean } | null;
      return !l?.hasPersonalData && !a.piiHits && l?.usefulForMarketing !== false;
    })
    .map((a) => ({ id: a.id, caption: String((a.labels as { caption?: string } | null)?.caption ?? "Screenshot") }));
}

async function carouselContexts(db: Db, l: Loaded) {
  const ctxs = new Map<SocialPlatform, ValidateContext>();
  for (const v of l.variants) ctxs.set(v.platform as SocialPlatform, await contextFor(db, l, v));
  return ctxs;
}

export async function carouselEditorView(db: Db, workspaceId: string, contentItemId: string): Promise<CarouselEditorView | null> {
  const l = await loadItem(db, workspaceId, contentItemId);
  if (!l || l.item.kind !== "carousel") return null;
  const bodies = l.variants.map((v) => ({ v, b: CarouselVariantBody.safeParse(v.body) }));
  const first = bodies.find((x) => x.b.success);
  const spec = first?.b.success ? first.b.data.spec : null;
  const brand = await brandFor(db, workspaceId, l.campaign.productId);
  const colors = slideColors(brand.colors);
  const ctxs = await carouselContexts(db, l);
  const platforms = l.variants.map((v) => v.platform as SocialPlatform).filter((p) => PLATFORM_LIMITS[p]);
  const issuesBy = spec ? validateCarousel(spec, (p) => ctxs.get(p) ?? null, platforms) : {};
  const refs = spec?.claimRefs ?? [];
  return {
    contentItemId: l.item.id,
    campaignId: l.campaign.id,
    status: l.item.status,
    needsYouReason: l.item.needsYouReason,
    day: l.item.day,
    costMicros: l.item.costMicros,
    slides: spec?.slides ?? [],
    slideChecks: (spec?.slides ?? []).map((s) => slideChecks(s, colors)),
    colors,
    altText: spec?.altText ?? null,
    claimRefs: refs,
    claims: refs.map((ref) => {
      const c = l.claims.get(ref);
      return { ref, text: c?.text ?? "A fact we don't have", publicOk: c?.publicOk ?? false, status: c?.status ?? "missing" };
    }),
    variants: bodies.flatMap(({ v, b }) => {
      const platform = v.platform as SocialPlatform;
      if (!PLATFORM_LIMITS[platform]) return [];
      const body = b.success ? b.data : null;
      const rendered = body?.renderedAssetIds ?? [];
      const editedAt = (v.qa as { editedAt?: string } | null)?.editedAt;
      return [
        {
          id: v.id,
          platform,
          output: carouselOutput(platform),
          caption: body?.caption ?? { text: "", hashtags: [] },
          captionLimit: textLimit(platform, formatFor(l, platform)),
          renderedAssetIds: rendered,
          rendering: !rendered.length || (!!editedAt && v.assetIds.length > 0 && new Date(editedAt) >= v.updatedAt),
          issues: issuesBy[platform] ?? ((v.qa as { issues?: CopyIssue[] } | null)?.issues ?? []),
          posts: editorPosts(l.posts, v.id),
          lockedReason: lockReason(l.posts.filter((p) => p.variantId === v.id)),
        },
      ];
    }),
    screenshots: await screenshotsFor(db, workspaceId, l.campaign.productId),
  };
}

export interface CarouselEdit {
  slides: CarouselSlide[];
  /** Per platform caption; platforms left out keep theirs. */
  captions?: Partial<Record<SocialPlatform, CarouselCaption>>;
  altText?: string | null;
}

export type CarouselSaveResult =
  | { ok: true; contentItemId: string; variantIds: string[]; renderVariantIds: string[]; issues: Record<string, CopyIssue[]> }
  | { ok: false; status: 404 | 409 | 400; message: string };

/**
 * Save a swipe post's slides (shared by every platform) and captions. The rendered images stay
 * until render.still replaces them (it voids approvals again when the files change). Returns the
 * variants to re-render: those without a blocking check.
 */
export async function saveCarousel(db: Db, workspaceId: string, contentItemId: string, edit: CarouselEdit, now = new Date()): Promise<CarouselSaveResult> {
  const l = await loadItem(db, workspaceId, contentItemId);
  if (!l || l.item.kind !== "carousel") return { ok: false, status: 404, message: "That swipe post wasn't found." };
  if (!l.variants.length) return { ok: false, status: 409, message: "This swipe post hasn't been written yet." };
  const locked = lockReason(l.posts);
  if (locked) return { ok: false, status: 409, message: locked };

  const bodies = l.variants.map((v) => ({ v, b: CarouselVariantBody.safeParse(v.body) }));
  const base = bodies.find((x) => x.b.success);
  if (!base?.b.success) return { ok: false, status: 409, message: "This swipe post came back unusable. Make a new one from the board." };
  const shotIds = new Set((await screenshotsFor(db, workspaceId, l.campaign.productId)).map((s) => s.id));
  if (edit.slides.some((s) => s.assetId && !shotIds.has(s.assetId))) return { ok: false, status: 400, message: "Pick a screenshot from this product." };

  const captions = { ...base.b.data.spec.captions };
  for (const [p, c] of Object.entries(edit.captions ?? {})) if (c) captions[p as SocialPlatform] = { text: c.text.trim(), hashtags: c.hashtags.map((h) => h.replace(/^#+/, "")).filter(Boolean) };
  const specTry = CarouselSpec.safeParse({
    ...base.b.data.spec,
    slides: edit.slides.map((s) => ({ ...s, headline: s.headline.trim(), body: s.body?.trim() || null })),
    captions,
    altText: edit.altText === undefined ? base.b.data.spec.altText : edit.altText?.trim() || null,
  });
  if (!specTry.success) {
    const first = specTry.error.issues[0];
    const msg = first?.message.includes("links or HTML")
      ? "Slides can't hold web addresses or HTML. The link goes in the caption."
      : first?.path.includes("slides")
        ? "A swipe post needs 3 to 10 slides, each with a headline."
        : "Every caption needs some text.";
    return { ok: false, status: 400, message: msg };
  }
  const spec = specTry.data;
  const ctxs = await carouselContexts(db, l);
  const platforms = l.variants.map((v) => v.platform as SocialPlatform);
  const issuesBy = validateCarousel(spec, (p) => ctxs.get(p) ?? null, platforms);

  const renderVariantIds: string[] = [];
  await db.transaction(async (tx) => {
    for (const { v, b } of bodies) {
      const platform = v.platform as SocialPlatform;
      const prev = b.success ? b.data : null;
      const body: CarouselVariantBody = {
        schemaVersion: 1,
        kind: "carousel",
        format: prev?.format ?? (formatFor(l, platform) as CarouselVariantBody["format"]),
        spec,
        caption: spec.captions[platform] ?? prev?.caption ?? { text: "", hashtags: [] },
        renderedAssetIds: prev?.renderedAssetIds ?? [],
      };
      const issues = issuesBy[platform] ?? [];
      if (!hasBlock(issues)) renderVariantIds.push(v.id);
      await tx
        .update(variants)
        .set({
          body: body as unknown as Record<string, unknown>,
          qa: { issues, checkedAt: now.toISOString(), editedAt: now.toISOString() },
          contentHash: variantContentHash({ platform, body }),
          updatedAt: now,
        })
        .where(eq(variants.id, v.id));
    }
  });
  await refreshItemStatus(db, workspaceId, l.item.id, now);
  return { ok: true, contentItemId: l.item.id, variantIds: l.variants.map((v) => v.id), renderVariantIds, issues: issuesBy };
}
