// The video editor's read model and its small write helpers (§2.3 Video editor, §4.3 video item).
// Everything the page needs in one workspace-scoped read, so the web app never reaches into
// video_specs.lint or renders.qa itself.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { CampaignPlan, HookVariant, SpecIssue, VideoSpec } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { ClaudeDeps } from "../ai/call.ts";
import { feature } from "../ai/features.ts";
import type { RateLookup } from "../ai/usage.ts";
import { estimateClaudeMicros } from "../cost/pricing.ts";
import type { AudioOps } from "./deps.ts";
import { runSpentMicros } from "../runs/summary.ts";
import { HOOK_KEY, type AudioPlan, type VoicedLine } from "./audio.ts";
import { loadVideoContext } from "./context.ts";
import { finalizeHash, finalSpecOf, type FinalMeta } from "./finalize.ts";
import { specHash } from "./hash.ts";
import type { SpecTools } from "./renderer.ts";
import { latestSpec, proposeSpecChange, type SpecChange, type SpecMeta } from "./spec.ts";
import { scopeForRun } from "./video-item.ts";
import type { VideoItemState } from "./video-item-state.ts";

const { approvals, assets, campaigns, contentItems, generationRuns, posts, renders, variants } = schema;

/** Mirrors @mkt/video lint's WPS band and HOOK_ONSCREEN_MAX_CHARS (core doesn't import @mkt/video). */
export const OPENING_WPS = { low: 1.8, high: 3.6 } as const;
export const OPENING_ONSCREEN_MAX_CHARS = 60;

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export interface OpeningLineCheck {
  idx: number;
  wps: number | null;
  problems: string[];
}

/** "Pre-checked" (§2.3): the deterministic checks each opening line gets before anything is paid for. */
export function openingLineChecks(spec: Pick<VideoSpec, "hookVariants">, lines: Record<string, Pick<VoicedLine, "text" | "durationMs">>): OpeningLineCheck[] {
  return spec.hookVariants.map((h, idx) => {
    const problems: string[] = [];
    if (!h.onScreen.trim()) problems.push("It has no on-screen text.");
    if (!h.vo.trim()) problems.push("It has no spoken line.");
    if (h.onScreen.length > OPENING_ONSCREEN_MAX_CHARS) problems.push(`The on-screen text is over ${OPENING_ONSCREEN_MAX_CHARS} characters.`);
    const line = lines[HOOK_KEY(idx)];
    const spoken = line && line.text === h.vo.replace(/\s+/g, " ").trim() ? line : null;
    const wps = spoken && spoken.durationMs > 0 ? Math.round((words(h.vo) / (spoken.durationMs / 1000)) * 10) / 10 : null;
    if (wps !== null && wps > OPENING_WPS.high) problems.push("It's spoken too fast to follow.");
    if (wps !== null && wps > 0 && wps < OPENING_WPS.low) problems.push("It's spoken slowly; the first seconds may drag.");
    return { idx, wps, problems };
  });
}

/**
 * Display order of the 3 opening lines: the text judge's pairwise ranking once a finalize ran
 * (§5.7 stage 3), else the checks (fewest problems, then the shorter on-screen text). Never a
 * predicted score.
 */
export function rankOpeningLines(
  spec: Pick<VideoSpec, "hookVariants">,
  checks: OpeningLineCheck[],
  judgeRanking?: number[] | null,
): { order: number[]; source: "judge" | "checks" } {
  const n = spec.hookVariants.length;
  const valid = judgeRanking && judgeRanking.length === n && new Set(judgeRanking).size === n && judgeRanking.every((i) => Number.isInteger(i) && i >= 0 && i < n);
  if (valid) return { order: [...judgeRanking], source: "judge" };
  const order = spec.hookVariants
    .map((h, idx) => ({ idx, p: checks[idx]?.problems.length ?? 0, len: h.onScreen.length }))
    .sort((a, b) => a.p - b.p || a.len - b.len || a.idx - b.idx)
    .map((x) => x.idx);
  return { order, source: "checks" };
}

// ── the read model ──

export interface EditorFootage {
  id: string;
  kind: string;
  origin: string;
  tier: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  caption: string | null;
}

export interface EditorRender {
  id: string;
  hookIdx: number;
  status: string;
  error: string | null;
  attempts: number;
  issues: SpecIssue[];
  fixes: string[];
  loudness: { lufs: number; truePeak: number } | null;
  outputAssetId: string | null;
  contactSheetAssetId: string | null;
  thumbAssetId: string | null;
  files: Record<string, string>;
}

export interface EditorFile {
  variantId: string;
  platform: string;
  hookIdx: number | null;
  format: string;
  videoAssetId: string | null;
  thumbAssetId: string | null;
  aiLabel: boolean;
  tier: string;
  rank: number | null;
  issues: SpecIssue[];
}

export interface EditorPost {
  id: string;
  variantId: string;
  platform: string;
  state: string;
  scheduledAt: string;
}

export interface EditorView {
  item: { id: string; status: VideoItemState; needsYouReason: string | null; productId: string; campaignId: string; kind: string };
  spec: VideoSpec | null;
  specId: string | null;
  version: number | null;
  editedBy: string | null;
  issues: SpecIssue[];
  /** Draft voice lines by key ("hook:0".., scene ids, "cta"); empty until the draft voice exists. */
  lines: Record<string, VoicedLine>;
  musicAssetId: string | null;
  noVoice: boolean;
  moreHooks: HookVariant[];
  checks: OpeningLineCheck[];
  hookOrder: number[];
  hookOrderSource: "judge" | "checks";
  /** What Gate 1 is keyed on (null without a spec); the page sends it back with the click. */
  finalizeHash: string | null;
  finalizeConfirmed: boolean;
  final: { specHash: string; tier: string; judgeIssues: SpecIssue[] } | null;
  renders: EditorRender[];
  files: EditorFile[];
  posts: EditorPost[];
  footage: EditorFootage[];
}

const asIssues = (v: unknown): SpecIssue[] => (Array.isArray(v) ? (v as SpecIssue[]).filter((i) => i && typeof i.message === "string") : []);

type SpecMetaWithFinal = SpecMeta & { final?: FinalMeta };

/** Workspace-scoped: throws VideoItemMissing when the item isn't this workspace's video. */
export async function videoEditorView(db: Db, workspaceId: string, contentItemId: string, now = new Date()): Promise<EditorView> {
  const v = await loadVideoContext(db, workspaceId, contentItemId, now);
  const row = await latestSpec(db, workspaceId, contentItemId);
  const spec = (row?.spec ?? null) as unknown as VideoSpec | null;
  const meta = (row?.lint ?? { issues: [] }) as unknown as SpecMetaWithFinal;
  const plan = meta.audio as unknown as AudioPlan | undefined;
  const lines = plan?.lines ?? {};
  const final = meta.final ?? null;

  const checks = spec ? openingLineChecks(spec, lines) : [];
  // The judge's ranking only counts while it ranked these exact lines.
  const current = !!(final && spec && final.specHash === specHash(finalSpecOf(spec)));
  const ranked = spec ? rankOpeningLines(spec, checks, current ? final!.judge?.ranking : null) : { order: [], source: "checks" as const };

  const fHash = spec ? finalizeHash(spec) : null;
  const [confirmed] = fHash
    ? await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.entityType, "video_finalize"), eq(approvals.entityId, contentItemId), eq(approvals.contentHash, fHash), isNull(approvals.voidedAt)))
    : [];

  const renderRows = final
    ? await db
        .select()
        .from(renders)
        .where(and(eq(renders.workspaceId, workspaceId), eq(renders.contentItemId, contentItemId), eq(renders.specHash, final.specHash), eq(renders.quality, "final")))
        .orderBy(asc(renders.hookIdx))
    : [];
  const rendersOut: EditorRender[] = renderRows.map((r) => {
    const qa = (r.qa ?? {}) as { issues?: unknown; fixes?: unknown; loudness?: { lufs: number; truePeak: number } };
    const { contact, thumb, ...files } = r.variantAssets;
    return {
      id: r.id,
      hookIdx: r.hookIdx,
      status: r.status,
      error: r.error,
      attempts: r.attempts,
      issues: asIssues(qa.issues),
      fixes: Array.isArray(qa.fixes) ? qa.fixes.filter((f): f is string => typeof f === "string") : [],
      loudness: qa.loudness && typeof qa.loudness.lufs === "number" ? qa.loudness : null,
      outputAssetId: r.outputAssetId,
      contactSheetAssetId: contact ?? null,
      thumbAssetId: thumb ?? null,
      files,
    };
  });

  const variantRows = await db.select().from(variants).where(and(eq(variants.workspaceId, workspaceId), eq(variants.contentItemId, contentItemId)));
  const videoVariants = variantRows.filter((x) => (x.body as { kind?: string }).kind === "video" && (!final || x.body.specHash === final.specHash));
  const files: EditorFile[] = videoVariants.map((x) => {
    const media = (Array.isArray(x.body.media) ? x.body.media : []) as { assetId: string; role: string }[];
    const qa = (x.qa ?? {}) as { issues?: unknown; rank?: unknown };
    return {
      variantId: x.id,
      platform: x.platform,
      hookIdx: x.hookIdx,
      format: typeof x.body.format === "string" ? x.body.format : "master",
      videoAssetId: media.find((m) => m.role === "video")?.assetId ?? x.assetIds[0] ?? null,
      thumbAssetId: media.find((m) => m.role === "thumbnail")?.assetId ?? null,
      aiLabel: x.body.aiLabel === true,
      tier: x.provenanceTier,
      rank: typeof qa.rank === "number" && qa.rank >= 0 ? qa.rank + 1 : null,
      issues: asIssues(qa.issues),
    };
  });

  const postRows = videoVariants.length
    ? await db
        .select({ id: posts.id, variantId: posts.variantId, platform: posts.platform, state: posts.state, scheduledAt: posts.scheduledAt })
        .from(posts)
        .where(and(eq(posts.workspaceId, workspaceId), inArray(posts.variantId, videoVariants.map((x) => x.id))))
    : [];

  return {
    item: { id: v.item.id, status: v.item.status as VideoItemState, needsYouReason: v.item.needsYouReason, productId: v.product.id, campaignId: v.campaign.id, kind: v.item.kind },
    spec,
    specId: row?.id ?? null,
    version: row?.version ?? null,
    editedBy: row?.editedBy ?? null,
    issues: asIssues(meta.issues),
    lines,
    musicAssetId: plan?.musicAssetId ?? spec?.music.trackAssetId ?? null,
    noVoice: meta.noVoice === true || plan?.noVoice === true,
    moreHooks: (meta.moreHooks ?? []) as HookVariant[],
    checks,
    hookOrder: ranked.order,
    hookOrderSource: ranked.source,
    finalizeHash: fHash,
    finalizeConfirmed: !!confirmed,
    final: final ? { specHash: final.specHash, tier: final.tier, judgeIssues: final.judge?.issues ?? [] } : null,
    renders: rendersOut,
    files,
    posts: postRows.map((p) => ({ ...p, scheduledAt: p.scheduledAt.toISOString() })),
    footage: v.footage.map((a) => ({
      id: a.id,
      kind: a.kind,
      origin: a.origin,
      tier: a.provenanceTier,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      caption: typeof (a.labels as { caption?: unknown } | null)?.caption === "string" ? ((a.labels as { caption: string }).caption) : null,
    })),
  };
}

// ── small runs for editor actions (each paid call needs a run: its cap + the ledger's run id) ──

export type VideoAction = "video_edit" | "hooks_more" | "change_request" | "finalize";

/** A run row for one editor action. Finalize gets kind "finalize"; the rest are small refills. */
export async function createVideoActionRun(
  db: Db,
  input: { workspaceId: string; contentItemId: string; action: VideoAction; capMicros: number; extra?: Record<string, unknown> },
): Promise<string> {
  const [row] = await db
    .select({ productId: campaigns.productId })
    .from(contentItems)
    .innerJoin(campaigns, eq(campaigns.id, contentItems.campaignId))
    .where(and(eq(contentItems.id, input.contentItemId), eq(contentItems.workspaceId, input.workspaceId)));
  if (!row) throw new Error("content item not found");
  const id = uuidv7();
  await db.insert(generationRuns).values({
    id,
    workspaceId: input.workspaceId,
    productId: row.productId,
    kind: input.action === "finalize" ? "finalize" : "refill",
    // Created "running"; executeFinalizeJob closes it once the renders are queued (or it fails).
    status: "running",
    input: { action: input.action, contentItemId: input.contentItemId, ...(input.extra ?? {}) },
    capMicros: input.capMicros,
    startedAt: new Date(),
  });
  return id;
}

/** Closes an inline action run with what it spent (the finalize run is closed by executeFinalizeJob). */
export async function finishVideoActionRun(db: Db, workspaceId: string, runId: string, ok: boolean, message: string): Promise<void> {
  const spentMicros = await runSpentMicros(db, runId);
  await db
    .update(generationRuns)
    .set({ status: ok ? "completed" : "failed", result: { message, spentMicros }, ...(ok ? {} : { error: message.slice(0, 500) }), finishedAt: new Date() })
    .where(and(eq(generationRuns.id, runId), eq(generationRuns.workspaceId, workspaceId)));
}

// ── "Ask for changes" (video.change_request) ──

/**
 * Proposes a revised spec for a plain-English request and returns the diff; nothing is saved. The
 * page shows the diff, and "Apply" saves it as a new version through saveVideoEdit (re-voice,
 * approvals voided if final files would change).
 */
export async function askForChanges(
  deps: ClaudeDeps & { tools: SpecTools; now?: () => Date },
  input: { runId: string; workspaceId: string; contentItemId: string; request: string },
): Promise<{ spec: VideoSpec; diff: SpecChange[]; issues: SpecIssue[] }> {
  const now = deps.now ? deps.now() : new Date();
  const v = await loadVideoContext(deps.db, input.workspaceId, input.contentItemId, now);
  const row = await latestSpec(deps.db, input.workspaceId, input.contentItemId);
  if (!row) throw new Error("no spec yet");
  const scope = await scopeForRun(deps.db, input.workspaceId, input.runId);
  return proposeSpecChange(
    { ai: { db: deps.db, rates: deps.rates, client: deps.client }, ...scope },
    deps.tools,
    v,
    row.spec as unknown as VideoSpec,
    input.request,
    now,
  );
}

// ── Gate 2 needs posts: final video variants get one pending post per planned slot ──

/**
 * writePlatformVariants (finalize.ts) writes the final variants but no posts. This adds one
 * pending_approval post per variant whose platform has a slot in the item's brief (scheduled at the
 * slot, like the text posts in engine/package.ts writeDrafts). Idempotent: a variant that already
 * has a post keeps it. Returns the approvable post ids and the platforms with no slot.
 */
export async function ensureVideoPosts(db: Db, workspaceId: string, contentItemId: string): Promise<{ postIds: string[]; unscheduled: string[] }> {
  const [item] = await db.select().from(contentItems).where(and(eq(contentItems.id, contentItemId), eq(contentItems.workspaceId, workspaceId)));
  if (!item) return { postIds: [], unscheduled: [] };
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, item.campaignId), eq(campaigns.workspaceId, workspaceId)));
  if (!c) return { postIds: [], unscheduled: [] };
  const plan = c.plan as unknown as CampaignPlan | null;
  const slotIds = new Set(((item.brief as { slotIds?: string[] } | null)?.slotIds ?? []).filter((s) => typeof s === "string"));
  const slots = (plan?.slots ?? []).filter((s) => slotIds.has(s.id));

  const vs = (await db.select().from(variants).where(and(eq(variants.contentItemId, item.id), eq(variants.workspaceId, workspaceId)))).filter(
    (x) => (x.body as { kind?: string }).kind === "video" && x.assetIds.length > 0,
  );
  if (!vs.length) return { postIds: [], unscheduled: [] };
  const existing = await db.select().from(posts).where(and(eq(posts.workspaceId, workspaceId), inArray(posts.variantId, vs.map((x) => x.id))));
  const unscheduled: string[] = [];
  for (const x of vs) {
    if (existing.some((p) => p.variantId === x.id)) continue;
    const slot = slots.find((s) => s.platform === x.platform);
    if (!slot) {
      unscheduled.push(x.platform);
      continue;
    }
    const postId = uuidv7();
    const [inserted] = await db
      .insert(posts)
      .values({
        id: postId,
        workspaceId,
        productId: c.productId,
        variantId: x.id,
        connectionId: slot.connectionId,
        platform: x.platform,
        scheduledAt: new Date(slot.scheduledAt),
        state: "pending_approval",
        generation: 1,
        idempotencyKey: `pst_${postId}_g1`,
      })
      .returning();
    if (inserted) existing.push(inserted);
  }
  return { postIds: existing.filter((p) => p.state === "pending_approval").map((p) => p.id), unscheduled };
}

// ── prices on the editor's buttons ──

/** "Ask for changes": one Sonnet call with the whole spec in and the whole spec back. */
export function estimateChangeRequestMicros(rates: RateLookup, specChars = 8_000): number {
  const cfg = feature("video.change_request");
  // In: the spec + footage list + request. Out: the whole spec again (about as long as it went in).
  return estimateClaudeMicros(specChars + 4_000, Math.max(1_000, Math.round(specChars / 3)), rates(cfg.model));
}

/** Draft re-voice of the given lines (what saving an edit with changed spoken lines costs). */
export function estimateRevoiceMicros(audio: AudioOps | null, texts: string[], voiceId: string): number {
  if (!audio) return 0;
  let micros = 0;
  for (const text of texts) {
    if (!text.trim()) continue;
    const ms = Math.max(600, (text.split(/\s+/).length / 2.5) * 1000);
    micros += audio.tts.estimate({ text, voiceId, quality: "draft" });
    micros += audio.align.estimate({ audio: new Uint8Array(), mime: "audio/mpeg", text, durationMs: ms });
  }
  return micros;
}
