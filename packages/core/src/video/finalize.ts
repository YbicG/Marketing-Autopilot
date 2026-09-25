import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SpecIssue, VideoScript, VideoSpec } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { variantContentHash } from "../engine/hash.ts";
import { budgetScopesForRun } from "../runs/summary.ts";
import type { CallCtx } from "../ingest/steps.ts";
import { adAudioFor, captionsFor, prepareAudio, voDurationsFor, type AudioPlan, type PaidScope } from "./audio.ts";
import { loadVideoContext, type VideoContext } from "./context.ts";
import { nowOf, type VideoDeps } from "./deps.ts";
import { hashOf, specHash } from "./hash.ts";
import { computeTier, digitalSourceType, type Ingredient, type ProvenanceTier } from "./provenance.ts";
import { recentSheetHashes, scanFootageForPii, sheetHashesFor, stage0, stage1Transcript, stage2Vision, stage3Judge, type BlurBox, type WerResult } from "./qa.ts";
import { encodeSheetHash, hasBlock } from "./qa-rules.ts";
import type { AdPropsLike, ProbePlatform } from "./renderer.ts";
import { latestSpec, lintContextFor, updateSpecMeta, type SpecMeta, type VideoSpecRow } from "./spec.ts";
import { linkLineage, storeAsset } from "./store.ts";
import { reasonFor, setItemStatus, transitionVideoItem, type VideoItemState } from "./video-item-state.ts";

const { approvals, contentItems, renders, variants, assets, generationRuns } = schema;

/** §5.6 step 7: at most 24 final renders per package; the rest wait for the night. */
export const MAX_FINAL_RENDERS_PER_PACKAGE = 24;
/** §7.2: final renders get 2 retries. */
export const MAX_RENDER_ATTEMPTS = 3;
/** Which transcode each platform posts (§5.6 step 7); others post the master. */
export const PLATFORM_TRANSCODE: Record<string, "tiktok" | "ig_reel" | "yt_short" | "x"> = {
  tiktok: "tiktok",
  instagram: "ig_reel",
  youtube: "yt_short",
  x: "x",
};
const DEFAULT_TARGETS = ["tiktok", "instagram", "youtube"];

export interface PlatformPlan {
  platform: string;
  hookIdx: number;
  /** Key in renders.variant_assets, or "master" for the loudnormed master. */
  file: "tiktok" | "ig_reel" | "yt_short" | "x" | "master";
}

/**
 * D16: one opening line per platform account, in brief order (A → first platform, B → second,
 * C → third, then round again). Without targets: TikTok, Reels, Shorts.
 */
export function platformPlan(brief: unknown, hookCount: number): PlatformPlan[] {
  const targets = (brief as { targets?: { platform: string }[] } | null)?.targets ?? [];
  const platforms = [...new Set(targets.map((t) => t.platform))];
  return (platforms.length ? platforms : DEFAULT_TARGETS).map((platform, i) => ({ platform, hookIdx: i % Math.max(1, hookCount), file: PLATFORM_TRANSCODE[platform] ?? "master" }));
}

// ── Gate 1: Finalize = a spend confirmation keyed on spec hash + opening lines + voice/model ──

/** The spec a finalize renders: same as the preview but voiced on the final model. */
export function finalSpecOf(spec: VideoSpec): VideoSpec {
  return { ...spec, voice: { ...spec.voice, model: "final" } };
}

/** What the Finalize confirmation is keyed on (§4.3). Any change to these needs a new confirmation. */
export function finalizeHash(spec: VideoSpec): string {
  const f = finalSpecOf(spec);
  return hashOf({ specHash: specHash(f), hooks: f.hookVariants, voice: f.voice.voiceId, model: "final" });
}

export class FinalizeNotConfirmed extends Error {
  readonly code = "finalize_not_confirmed";
  constructor() {
    super("This video changed since you clicked Finalize. Check it and click Finalize again.");
    this.name = "FinalizeNotConfirmed";
  }
}

/**
 * Called by the web route behind the Finalize button (UI cookie session only, D9). `shownHash` is
 * the finalizeHash the page displayed; a spec edited in between is refused.
 */
export async function confirmFinalize(
  db: Db,
  input: { workspaceId: string; contentItemId: string; userId: string; shownHash: string },
): Promise<{ approvalId: string; finalizeHash: string }> {
  const row = await latestSpec(db, input.workspaceId, input.contentItemId);
  if (!row) throw new FinalizeNotConfirmed();
  const hash = finalizeHash(row.spec as unknown as VideoSpec);
  if (hash !== input.shownHash) throw new FinalizeNotConfirmed();
  const [existing] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, input.workspaceId), eq(approvals.entityType, "video_finalize"), eq(approvals.entityId, input.contentItemId), eq(approvals.contentHash, hash), isNull(approvals.voidedAt)));
  if (existing) return { approvalId: existing.id, finalizeHash: hash };
  const id = uuidv7();
  await db.insert(approvals).values({ id, workspaceId: input.workspaceId, entityType: "video_finalize", entityId: input.contentItemId, contentHash: hash, approvedBy: input.userId });
  return { approvalId: id, finalizeHash: hash };
}

export async function assertFinalizeConfirmed(db: Db, workspaceId: string, contentItemId: string, spec: VideoSpec): Promise<string> {
  const hash = finalizeHash(spec);
  const [row] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.entityType, "video_finalize"), eq(approvals.entityId, contentItemId), eq(approvals.contentHash, hash), isNull(approvals.voidedAt)));
  if (!row) throw new FinalizeNotConfirmed();
  return row.id;
}

/** "Finalize 3 versions · ~$0.70": final voice for every line + alignment + music + transcripts. */
export function estimateFinalizeMicros(deps: Pick<VideoDeps, "audio">, spec: VideoSpec, totalMs: number): number {
  const a = deps.audio;
  if (!a) return 0;
  const lines = [...spec.hookVariants.map((h) => h.vo), ...spec.scenes.map((s) => s.vo ?? ""), spec.cta.vo].filter((t) => t.trim());
  let micros = 0;
  for (const text of lines) {
    const ms = Math.max(600, (text.split(/\s+/).length / 2.5) * 1000);
    micros += a.tts.estimate({ text, voiceId: spec.voice.voiceId, quality: "final" });
    micros += a.align.estimate({ audio: new Uint8Array(), mime: "audio/mpeg", text, durationMs: ms });
    micros += a.stt.estimate({ audio: new Uint8Array(), mime: "audio/mpeg", durationMs: ms });
  }
  if (!spec.music.trackAssetId) micros += a.music.estimate({ prompt: spec.music.mood, lengthMs: totalMs });
  // Vision + text judge: a few cents of Sonnet per video (§5.7).
  return micros + 3 * 20_000 + 15_000;
}

// ── what we remember about a finalize (video_specs.lint.final; there's no dedicated column) ──

export interface FinalMeta {
  runId: string;
  spec: VideoSpec;
  specHash: string;
  audio: AudioPlan;
  takes: Record<string, number>;
  wer: WerResult[];
  tier: ProvenanceTier;
  ingredients: string[];
  judge?: { issues: SpecIssue[]; ranking: number[] };
}

type SpecMetaWithFinal = SpecMeta & { final?: FinalMeta };

async function runScope(db: Db, workspaceId: string, runId: string): Promise<PaidScope> {
  const [run] = await db.select().from(generationRuns).where(and(eq(generationRuns.id, runId), eq(generationRuns.workspaceId, workspaceId)));
  if (!run) throw new Error("finalize run missing");
  return { workspaceId, runId, budgetPeriodIds: await budgetScopesForRun(db, workspaceId, runId, run.capMicros) };
}

const callCtxOf = (deps: VideoDeps, scope: PaidScope): CallCtx => ({ ai: { db: deps.db, rates: deps.rates, client: deps.client }, ...scope });

function referencedAssetIds(spec: VideoSpec): string[] {
  const ids = new Set<string>();
  for (const s of spec.scenes) {
    if (s.visual.assetId) ids.add(s.visual.assetId);
    if (s.compare?.left.assetId) ids.add(s.compare.left.assetId);
    if (s.compare?.right.assetId) ids.add(s.compare.right.assetId);
  }
  if (spec.brand.logoAssetId) ids.add(spec.brand.logoAssetId);
  if (spec.music.trackAssetId) ids.add(spec.music.trackAssetId);
  return [...ids];
}

async function tierFor(db: Db, workspaceId: string, spec: VideoSpec, plan: AudioPlan): Promise<{ tier: ProvenanceTier; ingredients: string[] }> {
  const ids = referencedAssetIds(spec);
  const rows = ids.length
    ? await db.select({ id: assets.id, origin: assets.origin, tier: assets.provenanceTier, kind: assets.kind }).from(assets).where(and(inArray(assets.id, ids), eq(assets.workspaceId, workspaceId)))
    : [];
  const ingredients: Ingredient[] = rows.map((r) => ({ kind: "asset", origin: r.origin, provenanceTier: r.tier, mediaKind: r.kind }));
  if (!plan.noVoice) ingredients.push({ kind: "tts" });
  if (plan.musicAssetId && !plan.musicFallback) ingredients.push({ kind: "music" });
  const lineIds = Object.values(plan.lines).flatMap((l) => (l.assetId ? [l.assetId] : []));
  return { tier: computeTier(ingredients), ingredients: [...rows.map((r) => r.id), ...lineIds, ...(plan.musicAssetId ? [plan.musicAssetId] : [])] };
}

async function itemVariants(db: Db, workspaceId: string, contentItemId: string) {
  return db.select().from(variants).where(and(eq(variants.contentItemId, contentItemId), eq(variants.workspaceId, workspaceId)));
}

/**
 * Any re-voice, auto-fix or re-render after approval voids the approval (§4.3). Called before the
 * files of an item change; the item drops back to finalizing.
 */
export async function voidForChange(deps: VideoDeps, item: { id: string; workspaceId: string; status: VideoItemState }, reason: string): Promise<void> {
  const vs = await itemVariants(deps.db, item.workspaceId, item.id);
  const withMedia = vs.filter((v) => v.assetIds.length > 0);
  if (withMedia.length) await deps.voidApprovalsFor(withMedia.map((v) => v.id), reason);
}

// ── video.finalize ──

/**
 * video.finalize: check Gate 1, voice every line on the final model, run the transcript check
 * (re-voicing lines over 5% WER, ≤2 takes), add music, then queue one final render per opening line.
 */
export async function executeFinalize(deps: VideoDeps, job: { runId: string; contentItemId: string; workspaceId: string }): Promise<void> {
  const { db } = deps;
  const now = nowOf(deps);
  const v = await loadVideoContext(db, job.workspaceId, job.contentItemId, now);
  const row = await latestSpec(db, job.workspaceId, job.contentItemId);
  if (!row) throw new FinalizeNotConfirmed();
  const draftSpec = row.spec as unknown as VideoSpec;
  await assertFinalizeConfirmed(db, job.workspaceId, job.contentItemId, draftSpec);

  const state = v.item.status as VideoItemState;
  if (state === "final_ready" || state === "approved") await voidForChange(deps, { id: v.item.id, workspaceId: job.workspaceId, status: state }, "The video was finalized again.");
  await setItemStatus(db, v.item, transitionVideoItem(state, "finalize").next);

  const scope = await runScope(db, job.workspaceId, job.runId);
  try {
    const spec = finalSpecOf(draftSpec);
    const hash = specHash(spec);
    const prevFinal = (row.lint as unknown as SpecMetaWithFinal | null)?.final;
    const takes = prevFinal?.specHash === hash ? prevFinal.takes : {};

    let plan = await prepareAudio(deps, scope, { productId: v.product.id, spec, quality: "final", withMusic: false });
    const t1 = await stage1Transcript(deps, scope, { productId: v.product.id, plan, takes });
    plan = t1.plan;
    const failed = t1.results.filter((r) => !r.passed);
    if (failed.length) {
      await needsYou(deps, v, `The voice still misreads ${failed.length === 1 ? "one line" : `${failed.length} lines`} after 2 takes (${failed.map((f) => f.key).join(", ")}). Reword ${failed.length === 1 ? "it" : "them"} and finalize again.`);
      return;
    }
    const maxMs = Math.max(...spec.hookVariants.map((_, i) => deps.tools.resolveTimeline(spec, voDurationsFor(plan, i), i).totalMs));
    if (!spec.music.trackAssetId) {
      const withMusic = await prepareAudio(deps, scope, { productId: v.product.id, spec, quality: "final", withMusic: true, timelineMs: () => maxMs });
      plan = { ...plan, musicAssetId: withMusic.musicAssetId, musicFallback: withMusic.musicFallback };
    }

    const { tier, ingredients } = await tierFor(db, job.workspaceId, spec, plan);
    const final: FinalMeta = { runId: job.runId, spec, specHash: hash, audio: plan, takes: t1.takes, wer: t1.results, tier, ingredients };
    await updateSpecMeta(db, job.workspaceId, row.id, { final } as Partial<SpecMetaWithFinal>);

    const delayMs = (await packageRenderCount(db, job.workspaceId, v.item.runId, v.item.id)) + spec.hookVariants.length > MAX_FINAL_RENDERS_PER_PACKAGE ? msUntilNight(now) : 0;
    for (let hookIdx = 0; hookIdx < spec.hookVariants.length; hookIdx++) {
      const id = await ensureRenderRow(db, { workspaceId: job.workspaceId, contentItemId: v.item.id, specHash: hash, hookIdx, format: spec.format });
      if (id.status !== "succeeded") await deps.enqueueRender(id.id, delayMs ? { delayMs } : undefined);
    }
    // Everything may already be rendered (same spec finalized again).
    await completeIfAllRendered(deps, job.workspaceId, v.item.id);
  } catch (err) {
    await failToNeedsYou(deps, v, err);
    throw err;
  }
}

/**
 * The video.finalize job payload has no workspace id: the run row is the authority. A spec that
 * changed after the click spends nothing and asks for a new confirmation.
 */
export async function executeFinalizeJob(deps: VideoDeps, data: { runId: string; contentItemId: string }): Promise<void> {
  const [run] = await deps.db.select({ workspaceId: generationRuns.workspaceId }).from(generationRuns).where(eq(generationRuns.id, data.runId));
  if (!run) return;
  const [item] = await deps.db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(and(eq(contentItems.id, data.contentItemId), eq(contentItems.workspaceId, run.workspaceId)));
  if (!item) return;
  try {
    await executeFinalize(deps, { ...data, workspaceId: run.workspaceId });
  } catch (err) {
    if (err instanceof FinalizeNotConfirmed) {
      await deps.publish?.({ type: "needs_input", message: err.message });
      return;
    }
    throw err;
  }
}

async function ensureRenderRow(db: Db, r: { workspaceId: string; contentItemId: string; specHash: string; hookIdx: number; format: VideoSpec["format"] }) {
  await db
    .insert(renders)
    .values({ id: uuidv7(), workspaceId: r.workspaceId, contentItemId: r.contentItemId, specHash: r.specHash, hookIdx: r.hookIdx, quality: "final", format: r.format })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: renders.id, status: renders.status })
    .from(renders)
    .where(and(eq(renders.specHash, r.specHash), eq(renders.hookIdx, r.hookIdx), eq(renders.quality, "final"), eq(renders.format, r.format), eq(renders.workspaceId, r.workspaceId)));
  if (row!.status === "failed") {
    await db.update(renders).set({ status: "queued", attempts: 0, error: null }).where(eq(renders.id, row!.id));
    return { id: row!.id, status: "queued" as const };
  }
  return row!;
}

/** Final renders already made for this package (other items), not counting failures. */
export async function packageRenderCount(db: Db, workspaceId: string, packageRunId: string | null, excludeItemId: string): Promise<number> {
  if (!packageRunId) return 0;
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(renders)
    .innerJoin(contentItems, eq(contentItems.id, renders.contentItemId))
    .where(and(eq(renders.workspaceId, workspaceId), eq(contentItems.runId, packageRunId), eq(renders.quality, "final"), ne(renders.status, "failed"), ne(renders.contentItemId, excludeItemId)));
  return Number(row?.n ?? 0);
}

/** Delay until 02:00 UTC ("the rest queue overnight"). */
export function msUntilNight(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * "Render again" for one opening line of the current final spec. An approved or final_ready video
 * loses its approval before the job is even queued (§4.3).
 */
export async function rerenderHook(deps: VideoDeps, input: { workspaceId: string; contentItemId: string; hookIdx: number }): Promise<string> {
  const { db } = deps;
  const row = await latestSpec(db, input.workspaceId, input.contentItemId);
  const final = (row?.lint as unknown as SpecMetaWithFinal | null)?.final;
  if (!row || !final) throw new FinalizeNotConfirmed();
  const v = await loadVideoContext(db, input.workspaceId, input.contentItemId, nowOf(deps));
  const state = v.item.status as VideoItemState;
  if (state === "final_ready" || state === "approved") {
    await voidForChange(deps, { id: v.item.id, workspaceId: input.workspaceId, status: state }, "The video was rendered again.");
  }
  await setItemStatus(db, v.item, "finalizing");
  const r = await ensureRenderRow(db, { workspaceId: input.workspaceId, contentItemId: v.item.id, specHash: final.specHash, hookIdx: input.hookIdx, format: final.spec.format });
  await db.update(renders).set({ status: "queued", attempts: 0, error: null }).where(eq(renders.id, r.id));
  await deps.enqueueRender(r.id);
  return r.id;
}

// ── render.video (runs under sem:heavy in the worker) ──

export interface RenderOutcome {
  status: "succeeded" | "failed" | "retry" | "superseded" | "needs_you";
  issues: SpecIssue[];
  fixes: string[];
}

/**
 * render.video: render the master → loudnorm → platform transcodes + contact sheet → XMP → QA
 * stages 0 and 2. One automatic fix per failure (loudness → re-normalize, platform spec →
 * re-transcode, a crashed render → re-render, ≤2), always before final_ready; otherwise Needs you.
 */
export async function executeRenderVideo(deps: VideoDeps, renderId: string): Promise<RenderOutcome> {
  const { db, renderer } = deps;
  const now = nowOf(deps);
  const [r] = await db.select().from(renders).where(eq(renders.id, renderId));
  if (!r) return { status: "superseded", issues: [], fixes: [] };
  if (r.status === "succeeded") return { status: "succeeded", issues: [], fixes: [] };

  const row = await latestSpec(db, r.workspaceId, r.contentItemId);
  const final = (row?.lint as unknown as SpecMetaWithFinal | null)?.final;
  if (!row || !final || final.specHash !== r.specHash) {
    await db.update(renders).set({ status: "failed", error: "superseded by a newer version", finishedAt: now }).where(eq(renders.id, r.id));
    return { status: "superseded", issues: [], fixes: [] };
  }
  const v = await loadVideoContext(db, r.workspaceId, r.contentItemId, now);
  const item = v.item;
  // A re-render of an already approved video voids the approval before anything changes.
  if (item.status === "final_ready" || item.status === "approved") {
    await voidForChange(deps, { id: item.id, workspaceId: item.workspaceId, status: item.status as VideoItemState }, "The video was rendered again.");
    await setItemStatus(db, item, "finalizing");
  }

  const attempts = r.attempts + 1;
  await db.update(renders).set({ status: "rendering", attempts, error: null }).where(eq(renders.id, r.id));
  const scope: PaidScope = { workspaceId: r.workspaceId, runId: final.runId, budgetPeriodIds: await runScope(db, r.workspaceId, final.runId).then((s) => s.budgetPeriodIds) };
  const dir = await mkdtemp(join(deps.workDir ?? tmpdir(), "mkt-render-"));
  const fixes: string[] = [];
  try {
    const spec = final.spec;
    const plan = final.audio;
    const timeline = deps.tools.resolveTimeline(spec, voDurationsFor(plan, r.hookIdx), r.hookIdx);
    const props: AdPropsLike = {
      spec,
      hookIdx: r.hookIdx,
      timeline,
      audio: adAudioFor(plan, r.hookIdx),
      captions: spec.captions.enabled ? captionsFor(plan, timeline, r.hookIdx) : null,
      aiLabel: final.tier !== "A",
    };
    const assetFiles = await materialize(deps, r.workspaceId, dir, [...referencedAssetIds(spec), ...props.audio.voSegments.map((s) => s.assetId), ...(props.audio.musicAssetId ? [props.audio.musicAssetId] : [])]);

    const raw = join(dir, "raw.mp4");
    try {
      await renderer.renderVideo({ spec, hookIdx: r.hookIdx, format: spec.format, quality: "final", props, assetFiles, outPath: raw, concurrency: deps.concurrency ?? 2 });
    } catch (err) {
      if (attempts < MAX_RENDER_ATTEMPTS) {
        await db.update(renders).set({ status: "queued", error: errText(err) }).where(eq(renders.id, r.id));
        await deps.enqueueRender(r.id);
        return { status: "retry", issues: [], fixes: ["re-render"] };
      }
      throw err;
    }

    await db.update(renders).set({ status: "postprocess" }).where(eq(renders.id, r.id));
    const master = join(dir, "master.mp4");
    await renderer.loudnormTwoPass(raw, master);
    let loud = await renderer.measureLoudness(master);
    if (Math.abs(loud.lufs + 14) > 1) {
      fixes.push("loudness");
      await renderer.loudnormTwoPass(raw, master);
      loud = await renderer.measureLoudness(master);
    }
    const outDir = join(dir, "out");
    await mkdir(outDir, { recursive: true });
    let files = await renderer.transcodeVariants(master, outDir);
    const sheetPath = join(dir, "sheet.jpg");
    await renderer.contactSheet(master, sheetPath);
    const openingPath = join(dir, "opening.jpg");
    await renderer.extractFrame(master, Math.min(1_500, Math.max(0, timeline.hookMs - 200)), openingPath);

    const probeFiles = async () => {
      const list: { platform: ProbePlatform; path: string }[] = [
        { platform: "master", path: master },
        { platform: "tiktok", path: files.tiktok },
        { platform: "ig_reel", path: files.ig_reel },
        { platform: "yt_short", path: files.yt_short },
      ];
      return Promise.all(list.map(async (p) => ({ platform: p.platform, probe: await renderer.ffprobe(p.path) })));
    };
    let probes = await probeFiles();
    if (probes.some((p) => renderer.checkAgainstPlatform(p.probe, p.platform).some((i) => i.severity === "block"))) {
      fixes.push("transcode");
      files = await renderer.transcodeVariants(master, outDir);
      probes = await probeFiles();
    }

    // XMP is the last change to each file (§5.6 step 7).
    const dst = digitalSourceType(final.tier);
    for (const p of [master, files.tiktok, files.ig_reel, files.yt_short, files.x]) await renderer.writeXmp(p, dst);

    await db.update(renders).set({ status: "qa" }).where(eq(renders.id, r.id));
    const sheet = new Uint8Array(await readFile(sheetPath));
    const sheetHashes = await sheetHashesFor(deps, sheet);
    const issues = stage0(deps, {
      spec,
      script: row.script as unknown as VideoScript,
      claims: v.claims,
      timeline,
      lintCtx: lintContextFor(v, now, voDurationsFor(plan, r.hookIdx)),
      probes,
      loudness: loud,
      sheetHashes,
      recent: await recentSheetHashes(db, r.workspaceId, v.product.id, item.id, now),
      now,
    });

    const ctx = callCtxOf(deps, scope);
    let blurBoxes: BlurBox[] = [];
    if (!hasBlock(issues)) {
      const vision = await stage2Vision(ctx, { openingFrameJpeg: new Uint8Array(await readFile(openingPath)), contactSheetJpeg: sheet, hookOnScreen: spec.hookVariants[r.hookIdx]!.onScreen, productName: v.product.name });
      issues.push(...vision.issues);
      blurBoxes = vision.blurBoxes;
      const pii = await scanFootageForPii(ctx, deps, referencedAssetIds(spec).filter((id) => v.footage.some((a) => a.id === id && a.origin === "captured")));
      if (pii.length) {
        issues.push({ code: "personal_data", severity: "block", message: "A screenshot in this video shows personal data. Blur it or pick another screenshot." });
        blurBoxes.push(...pii.flatMap((p) => p.boxes.map((b) => ({ image: "opening_frame" as const, tile: null, ...b, what: `${b.what} (asset ${p.assetId})` }))));
      }
    }

    const stored = await storeOutputs(deps, { workspaceId: r.workspaceId, productId: v.product.id, contentItemId: item.id, renderId: r.id, hookIdx: r.hookIdx, tier: final.tier, ingredients: final.ingredients, master, files, sheet, sheetHashes });
    const qa = { issues, fixes, blurBoxes, loudness: loud, probes: probes.map((p) => ({ platform: p.platform, durationMs: p.probe.durationMs, sizeBytes: p.probe.sizeBytes })) };

    if (hasBlock(issues)) {
      await db.update(renders).set({ status: "failed", outputAssetId: stored.master, variantAssets: stored.variants, qa, error: "qa", finishedAt: nowOf(deps) }).where(eq(renders.id, r.id));
      await needsYou(deps, v, issues.filter((i) => i.severity === "block").map((i) => i.message).slice(0, 3).join(" "));
      return { status: "needs_you", issues, fixes };
    }
    await db.update(renders).set({ status: "succeeded", outputAssetId: stored.master, variantAssets: stored.variants, qa, finishedAt: nowOf(deps) }).where(eq(renders.id, r.id));
    await completeIfAllRendered(deps, r.workspaceId, item.id);
    return { status: "succeeded", issues, fixes };
  } catch (err) {
    await db.update(renders).set({ status: "failed", error: errText(err), finishedAt: nowOf(deps) }).where(eq(renders.id, r.id));
    await failToNeedsYou(deps, v, err);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function materialize(deps: VideoDeps, workspaceId: string, dir: string, ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return {};
  const rows = await deps.db.select({ id: assets.id, storageKey: assets.storageKey }).from(assets).where(and(inArray(assets.id, unique), eq(assets.workspaceId, workspaceId)));
  await mkdir(join(dir, "a"), { recursive: true });
  const out: Record<string, string> = {};
  for (const a of rows) {
    const p = join(dir, "a", a.id);
    await writeFile(p, await deps.storage.get(a.storageKey));
    out[a.id] = p;
  }
  const missing = unique.filter((id) => !out[id]);
  if (missing.length) throw new Error(`assets missing: ${missing.join(", ")}`);
  return out;
}

async function storeOutputs(
  deps: VideoDeps,
  o: {
    workspaceId: string;
    productId: string;
    contentItemId: string;
    renderId: string;
    hookIdx: number;
    tier: ProvenanceTier;
    ingredients: string[];
    master: string;
    files: { tiktok: string; ig_reel: string; yt_short: string; x: string; thumb: string };
    sheet: Uint8Array;
    sheetHashes: string[];
  },
): Promise<{ master: string; variants: Record<string, string> }> {
  const put = async (path: string, kind: "video" | "still", mime: string, ext: string, purpose: string) => {
    const bytes = new Uint8Array(await readFile(path));
    const probe = kind === "video" ? await deps.renderer.ffprobe(path) : null;
    return storeAsset(deps.db, deps.storage, {
      workspaceId: o.workspaceId,
      productId: o.productId,
      kind,
      origin: "template",
      tier: o.tier,
      mime,
      ext,
      bytes,
      durationMs: probe?.durationMs ?? null,
      width: probe?.video?.width ?? null,
      height: probe?.video?.height ?? null,
      origination: { purpose, renderId: o.renderId, contentItemId: o.contentItemId, hookIdx: o.hookIdx },
      xmpWritten: kind === "video",
    });
  };
  const master = await put(o.master, "video", "video/mp4", "mp4", "master");
  await linkLineage(deps.db, o.workspaceId, master.id, o.ingredients, "rendered_from");
  const out: Record<string, string> = {};
  for (const key of ["tiktok", "ig_reel", "yt_short", "x"] as const) {
    const a = await put(o.files[key], "video", "video/mp4", "mp4", key);
    await linkLineage(deps.db, o.workspaceId, a.id, [master.id], "transcoded_from");
    out[key] = a.id;
  }
  const thumb = await put(o.files.thumb, "still", "image/webp", "webp", "thumb");
  out.thumb = thumb.id;
  const sheet = await storeAsset(deps.db, deps.storage, {
    workspaceId: o.workspaceId,
    productId: o.productId,
    kind: "still",
    origin: "template",
    tier: o.tier,
    mime: "image/jpeg",
    ext: "jpg",
    bytes: o.sheet,
    origination: { purpose: "contact_sheet", renderId: o.renderId, contentItemId: o.contentItemId, hookIdx: o.hookIdx, label: `opening line ${o.hookIdx + 1}` },
  });
  if (o.sheetHashes.length) await deps.db.update(assets).set({ phash: encodeSheetHash(o.sheetHashes) }).where(eq(assets.id, sheet.id));
  out.contact = sheet.id;
  return { master: master.id, variants: out };
}

// ── completion: stage 3, platform variants, final_ready ──

/**
 * When every opening line's final render passed: the text judge ranks the 3 opening lines and
 * checks honesty, then one variant per target platform is written (platformPlan) with its media sha256s, so the approval hash covers the final files.
 */
export async function completeIfAllRendered(deps: VideoDeps, workspaceId: string, contentItemId: string): Promise<boolean> {
  const { db } = deps;
  const row = await latestSpec(db, workspaceId, contentItemId);
  const meta = row?.lint as unknown as SpecMetaWithFinal | null;
  const final = meta?.final;
  if (!row || !final) return false;
  const rs = await db.select().from(renders).where(and(eq(renders.workspaceId, workspaceId), eq(renders.contentItemId, contentItemId), eq(renders.specHash, final.specHash), eq(renders.quality, "final")));
  const byHook = new Map(rs.filter((x) => x.status === "succeeded").map((x) => [x.hookIdx, x]));
  if (final.spec.hookVariants.some((_, i) => !byHook.has(i))) return false;

  const v = await loadVideoContext(db, workspaceId, contentItemId, nowOf(deps));
  if (v.item.status === "final_ready" || v.item.status === "approved") {
    // Already complete for this spec hash (duplicate delivery).
    const existing = await itemVariants(db, workspaceId, contentItemId);
    if (existing.every((x) => x.body.specHash === final.specHash)) return true;
  }
  const scope = await runScope(db, workspaceId, final.runId);
  const judge =
    final.judge ??
    (await stage3Judge(callCtxOf(deps, scope), {
      spec: final.spec,
      productName: v.product.name,
      timelines: final.spec.hookVariants.map((_, i) => deps.tools.resolveTimeline(final.spec, voDurationsFor(final.audio, i), i)),
      transcripts: Object.fromEntries(Object.entries(final.audio.lines).map(([k, l]) => [k, l.text])),
    }));
  await updateSpecMeta(db, workspaceId, row.id, { final: { ...final, judge } } as Partial<SpecMetaWithFinal>);
  if (hasBlock(judge.issues)) {
    await needsYou(deps, v, judge.issues.filter((i) => i.severity === "block").map((i) => i.message).join(" "));
    return false;
  }

  await writePlatformVariants(deps, v, final, byHook, judge.ranking);
  await setItemStatus(db, v.item, transitionVideoItem(v.item.status as VideoItemState, "final_qa_passed").next);
  await deps.publish?.({ type: "artifact_ready", kind: "video_final", id: contentItemId });
  return true;
}

/** Caption until the copy engine rewrites it per platform: the opening line's text + the last line. */
export function defaultVideoCaption(spec: VideoSpec, hookIdx: number): string {
  return [spec.hookVariants[hookIdx]!.onScreen, spec.cta.onScreen].filter(Boolean).join("\n\n");
}

async function writePlatformVariants(
  deps: VideoDeps,
  v: VideoContext,
  final: FinalMeta,
  byHook: Map<number, typeof renders.$inferSelect>,
  ranking: number[],
): Promise<string[]> {
  const { db } = deps;
  const existing = await itemVariants(db, v.item.workspaceId, v.item.id);
  const ids: string[] = [];
  for (const h of platformPlan(v.item.brief, final.spec.hookVariants.length)) {
    const r = byHook.get(h.hookIdx)!;
    const videoId = h.file === "master" ? r.outputAssetId! : r.variantAssets[h.file]!;
    const thumbId = r.variantAssets.thumb;
    const mediaIds = [videoId, ...(thumbId ? [thumbId] : [])];
    const rows = await db.select({ id: assets.id, sha256: assets.sha256 }).from(assets).where(inArray(assets.id, mediaIds));
    const sha = new Map(rows.map((x) => [x.id, x.sha256]));
    const media = mediaIds.map((id, i) => ({ assetId: id, sha256: sha.get(id)!, role: i === 0 ? "video" : "thumbnail" }));
    const prev = existing.find((x) => x.platform === h.platform && (x.body as { kind?: string }).kind === "video");
    const text = typeof prev?.body.text === "string" && prev.body.specHash === final.specHash ? prev.body.text : defaultVideoCaption(final.spec, h.hookIdx);
    const body = {
      schemaVersion: 1,
      kind: "video",
      format: h.file,
      text,
      title: h.platform === "youtube" ? final.spec.hookVariants[h.hookIdx]!.onScreen.slice(0, 100) : null,
      hookIdx: h.hookIdx,
      renderId: r.id,
      specHash: final.specHash,
      media,
      disclosures: final.spec.disclosures,
      aiLabel: final.tier !== "A",
    };
    // Same hash the publishing engine re-checks at publish.prepare: text + final media sha256s.
    const contentHash = variantContentHash({ platform: h.platform, body, mediaSha256s: media.map((m) => m.sha256) });
    const qa = { issues: (r.qa as { issues?: unknown } | null)?.issues ?? [], rank: ranking.indexOf(h.hookIdx), wer: final.wer };
    if (prev) {
      if (prev.contentHash !== contentHash && prev.assetIds.length) await deps.voidApprovalsFor([prev.id], "The final video file changed.");
      await db
        .update(variants)
        .set({ hookIdx: h.hookIdx, body, assetIds: mediaIds, qa, provenanceTier: final.tier, contentHash, updatedAt: nowOf(deps) })
        .where(eq(variants.id, prev.id));
      ids.push(prev.id);
    } else {
      const id = uuidv7();
      await db.insert(variants).values({ id, workspaceId: v.item.workspaceId, contentItemId: v.item.id, platform: h.platform, hookIdx: h.hookIdx, body, assetIds: mediaIds, qa, provenanceTier: final.tier, contentHash });
      ids.push(id);
    }
  }
  return ids;
}

// ── Needs you ──

async function needsYou(deps: VideoDeps, v: VideoContext, reason: string): Promise<void> {
  await setItemStatus(deps.db, v.item, "needs_you", reason.slice(0, 500));
  await deps.publish?.({ type: "needs_input", message: reason.slice(0, 500) });
}

async function failToNeedsYou(deps: VideoDeps, v: VideoContext, err: unknown): Promise<void> {
  await setItemStatus(deps.db, v.item, "needs_you", reasonFor(err)).catch(() => undefined);
}

export type { VideoSpecRow };
