import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  GENERATED_KIT_KINDS,
  KIT_LABELS,
  KitInputs,
  KitKind,
  type GeneratedKitKind,
  type KitIssue,
  type KitRunEstimate,
  type LaunchKitBody,
  type RunEvent,
  type SubredditKitBody,
} from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { callClaudeJson, StructuredOutputInvalid } from "../../ai/call.ts";
import { feature } from "../../ai/features.ts";
import { ClaudeRefused } from "../../ai/stop-reasons.ts";
import type { RateLookup } from "../../ai/usage.ts";
import { BudgetExceeded } from "../../cost/errors.ts";
import { withBundle } from "../../engine/bundle.ts";
import { MODEL_LIMIT, type FetchRules, type VenueRules } from "../../engine/copy.ts";
import type { KeyedLimit } from "../../engine/hash.ts";
import { ADS_KIT_CAP_MICROS } from "../../ads/index.ts";
import { budgetScopesForRun, runSpentMicros } from "../../runs/summary.ts";
import { skipOpenTasks, communityRules, syncSubredditTasks } from "./assisted.ts";
import { buildKitBody, type KitModelValue } from "./build.ts";
import { disclosuresOk, kitClaimRefs, kitHasBlock, plainifyKit, validateKitBody } from "./checks.ts";
import { KitNotReady, loadKitContext, kitPlanFor, type KitContext, type KitRow } from "./context.ts";
import { estimateKitRun } from "./estimate.ts";
import { KIT_FEATURE, KIT_SYSTEM, kitModelSchema, kitRepairTask, kitTask } from "./prompts.ts";

const { launchKits, generationRuns } = schema;

// Launch kit runs (§5.4 LC launch kit): one generation_runs row (kind launch_kit) per "Make" click
// for the written parts, plus its own run (kind ads_kit) for the ads export, which the ads module
// owns. One launch.kit job per kit. Postgres is the source of truth; every job re-reads it.

export interface AdsKitCtx {
  db: Db;
  runId: string;
  kitId: string;
  workspaceId: string;
  productId: string;
  launchPlanId: string;
  inputs: Record<string, unknown> | undefined;
}

export interface KitDeps {
  db: Db;
  rates: RateLookup;
  client?: Anthropic;
  /** Live progress for the run (Redis stream → SSE). */
  publish?: (runId: string, event: RunEvent) => Promise<unknown>;
  /** Fetches a community's rules page (safe-fetch); without it drafts are written without rules. */
  fetchRules?: FetchRules;
  /**
   * The "ads_export" kind belongs to the ads module: `(c) => executeAdsKit({ai, publish}, c)`. It
   * owns that kit row and its ads_kit run from then on; this module never touches either.
   */
  adsKit?: (ctx: AdsKitCtx) => Promise<unknown>;
  now?: () => Date;
  limit?: KeyedLimit;
}

export interface KitRunRequest {
  launchPlanId: string;
  kinds: readonly string[];
  inputs?: unknown;
}

function parseRequest(req: KitRunRequest): { kinds: KitKind[]; inputs: KitInputs } {
  const kinds = [...new Set(req.kinds)].map((k) => {
    const r = KitKind.safeParse(k);
    if (!r.success) throw new Error(`"${k}" isn't a kind of launch kit.`);
    return r.data;
  });
  if (!kinds.length) throw new Error("Pick at least one part of the launch kit.");
  const inputs = KitInputs.safeParse(req.inputs ?? {});
  if (!inputs.success) {
    const i = inputs.error.issues[0]!;
    throw new Error(`Check what you typed (${i.path.join(" › ") || "input"}): ${i.message}`);
  }
  return { kinds, inputs: inputs.data };
}

/** "Make the launch kit · ~$0.50": the estimate before anything is created. Null when the plan isn't in this workspace. */
export async function planKitRun(db: Db, workspaceId: string, req: KitRunRequest): Promise<(KitRunEstimate & { launchDate: string }) | null> {
  const { kinds } = parseRequest(req);
  const plan = await kitPlanFor(db, workspaceId, req.launchPlanId);
  if (!plan) return null;
  return { ...estimateKitRun(kinds), launchDate: plan.launchDate };
}

export interface CreatedKitRun {
  /** The launch_kit run, or the ads_kit run when only the ads export was picked. */
  runId: string;
  /** Every run created (the launch_kit run first, then the ads_kit run). */
  runIds: string[];
  kitIds: string[];
  /** Enqueue `launch.kit {runId, kitId}` with each kit's own runId. */
  kits: { kind: KitKind; kitId: string; runId: string }[];
  estimate: KitRunEstimate;
}

/**
 * Create (or reuse, one per plan + kind) the launch_kits rows and the run. Regenerating resets the
 * body, checks and export. The web route then enqueues `launch.kit {runId, kitId}` per kit with
 * jobId `kit-${kitId}-${uuidv7()}`.
 */
export async function createKitRun(db: Db, workspaceId: string, req: KitRunRequest & { userId: string }, now = new Date()): Promise<CreatedKitRun | null> {
  const { kinds, inputs } = parseRequest(req);
  const plan = await kitPlanFor(db, workspaceId, req.launchPlanId);
  if (!plan) return null;
  const estimate = estimateKitRun(kinds);

  const existing = await db.select().from(launchKits).where(and(eq(launchKits.workspaceId, workspaceId), eq(launchKits.launchPlanId, plan.id), inArray(launchKits.kind, kinds)));
  const busy = existing.find((k) => k.status === "generating");
  if (busy) throw new Error(`The ${KIT_LABELS[busy.kind].toLowerCase()} is still being written. Wait for it to finish.`);

  const written = kinds.filter(isGenerated);
  const withAds = kinds.includes("ads_export");
  const kitRunId = written.length ? uuidv7() : null;
  const adsRunId = withAds ? uuidv7() : null;
  const kits: { kind: KitKind; kitId: string; runId: string }[] = [];
  await db.transaction(async (tx) => {
    if (kitRunId) {
      const own = estimateKitRun(written);
      await tx.insert(generationRuns).values({
        id: kitRunId,
        workspaceId,
        productId: plan.productId,
        kind: "launch_kit",
        status: "queued",
        input: { launchPlanId: plan.id, kinds: written, inputs, estimate: own, userId: req.userId },
        capMicros: own.capMicros,
      });
    }
    if (adsRunId) {
      await tx.insert(generationRuns).values({
        id: adsRunId,
        workspaceId,
        productId: plan.productId,
        kind: "ads_kit",
        status: "queued",
        input: { launchPlanId: plan.id, kinds: ["ads_export"], inputs: inputs.ads_export ? { ads_export: inputs.ads_export } : {}, userId: req.userId },
        capMicros: ADS_KIT_CAP_MICROS,
      });
    }
    for (const kind of kinds) {
      const runId = kind === "ads_export" ? adsRunId! : kitRunId!;
      const [row] = await tx
        .insert(launchKits)
        .values({ id: uuidv7(), workspaceId, productId: plan.productId, launchPlanId: plan.id, kind, status: "planned", runId })
        .onConflictDoUpdate({
          target: [launchKits.launchPlanId, launchKits.kind],
          set: { status: "planned", body: null, issues: [], disclosuresOk: false, claimIds: [], exportAssetId: null, needsYouReason: null, runId, updatedAt: now },
        })
        .returning({ id: launchKits.id });
      kits.push({ kind, kitId: row!.id, runId });
    }
  });
  // The old drafts' Copy & open tasks go away with them.
  const oldSub = existing.find((k) => k.kind === "subreddit")?.body as SubredditKitBody | null | undefined;
  if (oldSub?.assistedTaskIds?.length) await skipOpenTasks(db, workspaceId, oldSub.assistedTaskIds);
  const runIds = [kitRunId, adsRunId].filter((x): x is string => !!x);
  return { runId: runIds[0]!, runIds, kitIds: kits.map((k) => k.kitId), kits, estimate };
}

// ── the job ──

type RunRow = typeof generationRuns.$inferSelect;

const BUDGET_REASON = "Paused: this would go over your spending limit.";
const REFUSED_REASON = "Claude declined to write this part. Change what you asked for, or skip it.";
const SHAPE_REASON = "It came back in the wrong shape twice. Try again.";
const FAILED_REASON = "Something went wrong writing this part. Try again.";

const mergeResult = (patch: Record<string, unknown>) => sql`coalesce(${generationRuns.result}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
const isGenerated = (k: KitKind): k is GeneratedKitKind => (GENERATED_KIT_KINDS as readonly string[]).includes(k);
const blockMessages = (issues: readonly KitIssue[]) => issues.filter((i) => i.severity === "block").map((i) => i.message);

/**
 * launch.kit (generate queue, paid, 1 attempt): write one kit, check it, one repair for blocking
 * issues, store it, and close the run once every kit of the run has finished.
 */
export async function executeLaunchKit(deps: KitDeps, data: { runId: string; kitId: string }): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, data.runId));
  if (run?.kind === "ads_kit") return runAdsKit(deps, run, data.kitId);
  if (!run || run.kind !== "launch_kit") return;
  const [kit] = await db.select().from(launchKits).where(and(eq(launchKits.id, data.kitId), eq(launchKits.workspaceId, run.workspaceId)));
  if (!kit || kit.runId !== run.id) return; // regenerated by a newer run
  if (run.status !== "queued" && run.status !== "running") return;
  const [won] = await db
    .update(launchKits)
    .set({ status: "generating", updatedAt: now() })
    .where(and(eq(launchKits.id, kit.id), eq(launchKits.status, "planned"), eq(launchKits.runId, run.id)))
    .returning({ id: launchKits.id });
  if (!won) return; // duplicate delivery
  if (run.status === "queued") {
    await db.update(generationRuns).set({ status: "running", startedAt: now() }).where(and(eq(generationRuns.id, run.id), eq(generationRuns.status, "queued")));
  }
  const stage = `kit.${kit.kind}`;
  await deps.publish?.(run.id, { type: "stage_started", stage, label: `Writing your ${KIT_LABELS[kit.kind].toLowerCase()}` });

  const inputs = KitInputs.safeParse(run.input.inputs ?? {});
  const kitInputs = inputs.success ? inputs.data : {};
  try {
    const periods = await budgetScopesForRun(db, run.workspaceId, run.id, run.capMicros);
    if (isGenerated(kit.kind)) await writeKit(deps, run, kit, kit.kind, kitInputs, periods);
    else await setKit(db, kit.id, { status: "needs_you", needsYouReason: "Make the ads kit again." }, now());
    await deps.publish?.(run.id, { type: "artifact_ready", kind: "launch_kit", id: kit.id });
    await deps.publish?.(run.id, { type: "stage_done", stage });
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      await setKit(db, kit.id, { status: "needs_you", needsYouReason: BUDGET_REASON }, now());
      await db.update(generationRuns).set({ status: "paused_budget", error: err.message }).where(and(eq(generationRuns.id, run.id), inArray(generationRuns.status, ["queued", "running"])));
      await deps.publish?.(run.id, { type: "stage_failed", stage, code: err.code, message: BUDGET_REASON, retryable: false });
    } else if (err instanceof ClaudeRefused) {
      // D15: store the stop details, mark it Needs you, never switch models.
      await setKit(db, kit.id, { status: "needs_you", needsYouReason: REFUSED_REASON }, now());
      await db.update(generationRuns).set({ result: mergeResult({ [`refusal:${kit.id}`]: { kind: kit.kind, stopDetails: err.stopDetails ?? null } }) }).where(eq(generationRuns.id, run.id));
      await deps.publish?.(run.id, { type: "stage_warning", stage, message: REFUSED_REASON });
    } else if (err instanceof StructuredOutputInvalid) {
      await setKit(db, kit.id, { status: "needs_you", needsYouReason: SHAPE_REASON }, now());
      await deps.publish?.(run.id, { type: "stage_warning", stage, message: SHAPE_REASON });
    } else if (err instanceof KitNotReady) {
      await setKit(db, kit.id, { status: "needs_you", needsYouReason: err.message }, now());
      await deps.publish?.(run.id, { type: "stage_warning", stage, message: err.message });
    } else {
      await setKit(db, kit.id, { status: "failed", needsYouReason: FAILED_REASON }, now());
      await deps.publish?.(run.id, { type: "stage_failed", stage, code: "kit_failed", message: FAILED_REASON, retryable: true });
      console.error("[launch] kit failed", kit.id, err);
    }
  } finally {
    await closeKitRun(deps, run.id);
  }
}

async function setKit(db: Db, id: string, p: { status: KitRow["status"]; needsYouReason: string | null }, at: Date) {
  await db.update(launchKits).set({ ...p, updatedAt: at }).where(eq(launchKits.id, id));
}

/** An ads_kit run: hand the kit to the ads module, which owns the kit row and the run from here. */
async function runAdsKit(deps: KitDeps, run: RunRow, kitId: string): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const [kit] = await db.select().from(launchKits).where(and(eq(launchKits.id, kitId), eq(launchKits.workspaceId, run.workspaceId)));
  if (!kit || kit.kind !== "ads_export" || kit.runId !== run.id) return;
  if (run.status !== "queued" && run.status !== "running") return;
  if (!deps.adsKit) {
    const reason = "The ads kit isn't switched on yet.";
    await setKit(db, kit.id, { status: "needs_you", needsYouReason: reason }, now());
    await db.update(generationRuns).set({ status: "failed", error: "ads_kit_unavailable", finishedAt: now() }).where(eq(generationRuns.id, run.id));
    await deps.publish?.(run.id, { type: "stage_failed", stage: "kit.ads_export", code: "ads_kit_unavailable", message: reason, retryable: false });
    return;
  }
  const inputs = KitInputs.safeParse(run.input.inputs ?? {});
  await deps.adsKit({
    db,
    runId: run.id,
    kitId: kit.id,
    workspaceId: run.workspaceId,
    productId: kit.productId,
    launchPlanId: kit.launchPlanId!,
    inputs: inputs.success ? inputs.data.ads_export : undefined,
  });
}

async function writeKit(deps: KitDeps, run: RunRow, kit: KitRow, kind: GeneratedKitKind, inputs: KitInputs, periods: string[]) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const ctx = await loadKitContext(db, kit, inputs, now());

  const rules = new Map<string, VenueRules | null>();
  if (kind === "subreddit") {
    for (const c of inputs.subreddit?.communities ?? []) rules.set(c, await communityRules(db, run.workspaceId, c, deps.fetchRules, now()));
  }
  const task = kitTask(kind, { productName: ctx.build.productName, launchDate: ctx.plan.launchDate, inputs, rules, assets: ctx.build.assets });
  const ask = (text: string) =>
    (deps.limit ?? MODEL_LIMIT).run(feature(KIT_FEATURE[kind]).model, () =>
      callClaudeJson(
        { db, rates: deps.rates, client: deps.client },
        {
          workspaceId: run.workspaceId,
          budgetPeriodIds: periods,
          runId: run.id,
          feature: KIT_FEATURE[kind],
          schema: kitModelSchema(kind),
          system: KIT_SYSTEM[kind],
          messages: withBundle(ctx.bundle, text),
        },
      ),
    );

  const first = await ask(task);
  let result = checked(kind, first.value as KitModelValue, ctx);
  let repaired = false;
  if (result.error || kitHasBlock(result.issues) || result.issues.some((i) => i.code === "jargon")) {
    const problems = result.error ? [`The answer was missing parts: ${result.error}`] : result.issues.filter((i) => i.severity === "block" || i.code === "jargon").map((i) => i.message);
    const fix = await ask(kitRepairTask(task, problems, first.value));
    const again = checked(kind, fix.value as KitModelValue, ctx);
    if (!again.error || result.error) result = again;
    repaired = true;
  }
  if (repaired && result.body && result.issues.some((i) => i.code === "jargon")) {
    const body = plainifyKit(result.body);
    result = { ...result, body, issues: [...result.issues.filter((i) => i.code === "raw_link_removed" || i.code === "no_site" || i.code === "bad_site"), ...validateKitBody(body, ctx.check)] };
  }

  if (!result.body) {
    await db
      .update(launchKits)
      .set({ status: "needs_you", body: null, issues: [], disclosuresOk: false, needsYouReason: `It came back incomplete: ${result.error}`.slice(0, 300), updatedAt: now() })
      .where(eq(launchKits.id, kit.id));
    return;
  }

  let body = result.body;
  const blocked = kitHasBlock(result.issues);
  if (body.kind === "subreddit" && !blocked) {
    // Suggested communities: snapshot their rules now (best effort) so the task shows them.
    for (const d of body.drafts) if (!rules.has(d.subreddit)) rules.set(d.subreddit, await communityRules(db, run.workspaceId, d.subreddit, deps.fetchRules, now()));
    body = await syncSubredditTasks(
      db,
      run.workspaceId,
      body,
      {
        productId: kit.productId,
        site: ctx.build.site,
        campaign: ctx.build.campaign,
        dueDate: inputs.subreddit?.dueDate ?? ctx.plan.launchDate,
        timezone: ctx.timezone,
        rules,
      },
      now(),
    );
  }
  await storeKit(db, kit.id, body, result.issues, now());
}

function checked(kind: GeneratedKitKind, model: KitModelValue, ctx: KitContext): { body: LaunchKitBody | null; issues: KitIssue[]; error: string | null } {
  const built = buildKitBody(kind, model, ctx.build);
  if (!built.body) return built;
  return { body: built.body, issues: [...built.issues, ...validateKitBody(built.body, ctx.check)], error: null };
}

/** Status from the checks: any blocking issue → Needs you with the first one as the reason. */
export async function storeKit(db: Db, kitId: string, body: LaunchKitBody, issues: KitIssue[], at: Date, extra: { exportAssetId?: null } = {}) {
  const blocks = blockMessages(issues);
  await db
    .update(launchKits)
    .set({
      body: body as unknown as Record<string, unknown>,
      issues,
      disclosuresOk: disclosuresOk(issues),
      claimIds: kitClaimRefs(body),
      status: blocks.length ? "needs_you" : "ready",
      needsYouReason: blocks[0] ?? null,
      updatedAt: at,
      ...extra,
    })
    .where(eq(launchKits.id, kitId));
}

/** When no kit of the run is planned or generating: completed (or failed if every kit failed). */
export async function closeKitRun(deps: Pick<KitDeps, "db" | "publish" | "now">, runId: string): Promise<boolean> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const kits = await db.select({ status: launchKits.status }).from(launchKits).where(eq(launchKits.runId, runId));
  if (!kits.length || kits.some((k) => k.status === "planned" || k.status === "generating")) return false;
  const count = (s: KitRow["status"]) => kits.filter((k) => k.status === s).length;
  const allFailed = count("failed") === kits.length;
  const spent = await runSpentMicros(db, runId);
  const res = await db
    .update(generationRuns)
    .set({
      status: allFailed ? "failed" : "completed",
      result: mergeResult({ ready: count("ready"), needsYou: count("needs_you"), failed: count("failed"), spentMicros: spent }),
      finishedAt: now(),
      ...(allFailed ? { error: "Every part of the kit failed." } : {}),
    })
    .where(and(eq(generationRuns.id, runId), inArray(generationRuns.status, ["queued", "running"])))
    .returning({ id: generationRuns.id });
  if (!res.length) return false;
  await deps.publish?.(runId, { type: "cost_update", spentMicros: spent });
  if (allFailed) await deps.publish?.(runId, { type: "stage_failed", stage: "launch_kit", code: "kit_failed", message: "The launch kit didn't come through. Try again.", retryable: true });
  else await deps.publish?.(runId, { type: "run_completed" });
  return true;
}
