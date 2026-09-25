import { and, eq } from "drizzle-orm";
import type { SpecIssue, VideoFormat, VideoScript, VideoSpec } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { StructuredOutputInvalid } from "../ai/call.ts";
import { ClaudeRefused } from "../ai/stop-reasons.ts";
import { BudgetExceeded } from "../cost/errors.ts";
import type { CallCtx } from "../ingest/steps.ts";
import { budgetScopesForRun } from "../runs/summary.ts";
import { adAudioFor, captionsFor, prepareAudio, voDurationsFor, type AudioPlan, type PaidScope } from "./audio.ts";
import { loadVideoContext, type VideoContext } from "./context.ts";
import { nowOf, type VideoDeps } from "./deps.ts";
import { voidForChange } from "./finalize.ts";
import type { AdPropsLike } from "./renderer.ts";
import { ScriptNeedsYou, writeMoreHooks, writeVideoScript } from "./script.ts";
import { compileVideoSpec, latestSpec, lintContextFor, saveSpecVersion, SpecNeedsYou, updateSpecMeta, type SpecMeta } from "./spec.ts";
import { reasonFor, setItemStatus, transitionVideoItem, type VideoItemState } from "./video-item-state.ts";

const { generationRuns } = schema;

export const DEFAULT_TARGET_SECONDS = 30;
export const DEFAULT_FORMAT: VideoFormat = "9x16";

/** The engine's generator entry (package.item for kind "video"). */
export async function videoGenerator(deps: VideoDeps, ctx: { runId: string; workspaceId: string; contentItemId: string }): Promise<void> {
  await runVideoItem(deps, ctx.runId, ctx.workspaceId, ctx.contentItemId);
}

/** Errors that end in Needs you without a retry (§7.2: one repair, then Needs you; D15 refusals). */
function isNeedsYou(err: unknown): boolean {
  return err instanceof ScriptNeedsYou || err instanceof SpecNeedsYou || err instanceof ClaudeRefused || err instanceof BudgetExceeded || err instanceof StructuredOutputInvalid;
}

export async function scopeForRun(db: Db, workspaceId: string, runId: string): Promise<PaidScope> {
  const [run] = await db.select({ capMicros: generationRuns.capMicros }).from(generationRuns).where(and(eq(generationRuns.id, runId), eq(generationRuns.workspaceId, workspaceId)));
  if (!run) throw new Error("run not found");
  return { workspaceId, runId, budgetPeriodIds: await budgetScopesForRun(db, workspaceId, runId, run.capMicros) };
}

const callCtx = (deps: VideoDeps, scope: PaidScope): CallCtx => ({ ai: { db: deps.db, rates: deps.rates, client: deps.client }, ...scope });

function targetSecondsOf(v: VideoContext): 15 | 30 | 45 {
  const t = (v.item.brief as { targetSeconds?: number } | null)?.targetSeconds;
  return t === 15 || t === 45 ? t : DEFAULT_TARGET_SECONDS;
}

/**
 * §5.6 steps 2/3/5: script (Opus) → spec (Sonnet) + lint → draft voice (Flash, cached per line)
 * with the bundled track → ready (the editor plays the preview in the browser). Idempotent: a spec
 * saved by an earlier attempt is reused, and a finished item is left alone.
 */
export async function runVideoItem(deps: VideoDeps, runId: string, workspaceId: string, contentItemId: string): Promise<void> {
  const { db } = deps;
  const now = nowOf(deps);
  const v = await loadVideoContext(db, workspaceId, contentItemId, now);
  const state = v.item.status as VideoItemState;
  if (state !== "planned" && state !== "generating" && state !== "failed" && state !== "needs_you") return;
  await setItemStatus(db, v.item, transitionVideoItem(state, "start").next);
  try {
    const scope = await scopeForRun(db, workspaceId, runId);
    const ctx = callCtx(deps, scope);
    let row = await latestSpec(db, workspaceId, contentItemId);
    if (!row) {
      await deps.publish?.({ type: "stage_started", stage: "video.script", label: "Writing the video script" });
      const targetSeconds = targetSecondsOf(v);
      const script = await writeVideoScript(ctx, v, { targetSeconds });
      await deps.publish?.({ type: "stage_started", stage: "video.spec", label: "Planning the scenes" });
      const { spec, issues } = await compileVideoSpec(ctx, deps.tools, v, script, {
        targetSeconds,
        format: DEFAULT_FORMAT,
        voiceId: deps.defaultVoiceId ?? "default",
        now,
      });
      row = await saveSpecVersion(db, { workspaceId, contentItemId, script, spec, meta: { issues }, editedBy: "model" });
    }
    await draftVoice(deps, scope, v, row.id, row.spec as unknown as VideoSpec);
    await setItemStatus(db, v.item, transitionVideoItem(v.item.status as VideoItemState, "generated").next);
    await deps.publish?.({ type: "artifact_ready", kind: "video_preview", id: contentItemId });
  } catch (err) {
    await setItemStatus(db, v.item, "needs_you", reasonFor(err));
    await deps.publish?.({ type: "needs_input", message: reasonFor(err) });
    if (!isNeedsYou(err)) throw err; // BullMQ retries; the next attempt starts from needs_you
  }
}

/** Draft voice for every line (cache hits cost nothing) + a re-lint with the measured lengths. */
async function draftVoice(deps: VideoDeps, scope: PaidScope, v: VideoContext, specId: string, spec: VideoSpec): Promise<AudioPlan> {
  await deps.publish?.({ type: "stage_started", stage: "video.voice", label: "Recording a draft voice" });
  const plan = await prepareAudio(deps, scope, { productId: v.product.id, spec, quality: "draft", withMusic: false });
  // Words per second measured on the real audio (lint used estimates before).
  const issues: SpecIssue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < spec.hookVariants.length; i++) {
    for (const issue of deps.tools.lintSpec(spec, lintContextFor(v, nowOf(deps), voDurationsFor(plan, i)))) {
      const k = `${issue.code}|${issue.sceneId ?? ""}|${issue.message}`;
      if (!seen.has(k)) issues.push(issue), seen.add(k);
    }
  }
  await updateSpecMeta(deps.db, scope.workspaceId, specId, { issues, audio: plan as unknown as Record<string, unknown>, noVoice: plan.noVoice });
  return plan;
}

/**
 * Editor save (§2.3): a user-edited spec becomes a new version; only changed lines are re-voiced
 * (tts_segments cache). An edit after final_ready voids the approval and the item goes back to ready
 * (Finalize must be confirmed again: the finalize hash changed).
 */
export async function saveVideoEdit(
  deps: VideoDeps,
  input: { runId: string; workspaceId: string; contentItemId: string; spec: VideoSpec; editedBy?: "user" | "model" },
): Promise<{ specId: string; issues: SpecIssue[] }> {
  const { db } = deps;
  const v = await loadVideoContext(db, input.workspaceId, input.contentItemId, nowOf(deps));
  const prev = await latestSpec(db, input.workspaceId, input.contentItemId);
  if (!prev) throw new Error("no spec to edit");
  const from = v.item.status as VideoItemState;
  const t = transitionVideoItem(from, "edit");
  if (t.voidApproval) await voidForChange(deps, { id: v.item.id, workspaceId: input.workspaceId, status: from }, "The video was edited.");
  const prevMeta = (prev.lint ?? { issues: [] }) as unknown as SpecMeta;
  const row = await saveSpecVersion(db, {
    workspaceId: input.workspaceId,
    contentItemId: input.contentItemId,
    script: prev.script as unknown as VideoScript,
    spec: input.spec,
    meta: { issues: [], ...(prevMeta.moreHooks ? { moreHooks: prevMeta.moreHooks } : {}) },
    editedBy: input.editedBy ?? "user",
  });
  const scope = await scopeForRun(db, input.workspaceId, input.runId);
  await draftVoice(deps, scope, v, row.id, input.spec);
  await setItemStatus(db, v.item, t.next);
  const saved = await latestSpec(db, input.workspaceId, input.contentItemId);
  return { specId: row.id, issues: ((saved?.lint ?? { issues: [] }) as unknown as SpecMeta).issues };
}

/** "Write 3 more" opening lines (Opus): kept beside the spec, swapped in by an edit. */
export async function moreOpeningLines(deps: VideoDeps, input: { runId: string; workspaceId: string; contentItemId: string }) {
  const v = await loadVideoContext(deps.db, input.workspaceId, input.contentItemId, nowOf(deps));
  const row = await latestSpec(deps.db, input.workspaceId, input.contentItemId);
  if (!row) throw new Error("no spec yet");
  const spec = row.spec as unknown as VideoSpec;
  const meta = (row.lint ?? { issues: [] }) as unknown as SpecMeta;
  const scope = await scopeForRun(deps.db, input.workspaceId, input.runId);
  const existing = [...spec.hookVariants, ...((meta.moreHooks ?? []) as VideoSpec["hookVariants"])];
  const more = await writeMoreHooks(callCtx(deps, scope), v, row.script as unknown as VideoScript, existing);
  await updateSpecMeta(deps.db, input.workspaceId, row.id, { moreHooks: [...(meta.moreHooks ?? []), ...more] });
  return more;
}

/**
 * The browser preview (D8: asset ids only; the page maps them to signed URLs). Uses the draft
 * voice saved with the latest spec version; null until the first draft voice exists.
 */
export async function previewProps(deps: Pick<VideoDeps, "db" | "tools">, workspaceId: string, contentItemId: string, hookIdx: number): Promise<AdPropsLike | null> {
  const row = await latestSpec(deps.db, workspaceId, contentItemId);
  if (!row) return null;
  const meta = (row.lint ?? { issues: [] }) as unknown as SpecMeta;
  const plan = meta.audio as unknown as AudioPlan | undefined;
  if (!plan?.lines) return null;
  const spec = row.spec as unknown as VideoSpec;
  const idx = Math.min(Math.max(0, hookIdx), spec.hookVariants.length - 1);
  const timeline = deps.tools.resolveTimeline(spec, voDurationsFor(plan, idx), idx);
  return {
    spec,
    hookIdx: idx,
    timeline,
    audio: adAudioFor(plan, idx),
    captions: spec.captions.enabled || plan.noVoice ? captionsFor(plan, timeline, idx) : null,
    aiLabel: !plan.noVoice,
  };
}
