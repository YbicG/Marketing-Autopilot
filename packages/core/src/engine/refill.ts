import { and, eq, inArray } from "drizzle-orm";
import {
  M2_GENERATORS,
  OPENING_STYLES,
  TextVariantBody,
  type CampaignPlan,
  type GeneratorId,
  type ItemBrief,
  type OpeningStyle,
  type PlanItem,
  type PostFormat,
  type SocialPlatform,
} from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { StructuredOutputInvalid } from "../ai/call.ts";
import { ClaudeRefused } from "../ai/stop-reasons.ts";
import { BudgetExceeded } from "../cost/errors.ts";
import { budgetScopesForRun, runSpentMicros } from "../runs/summary.ts";
import { KIND_GENERATOR } from "./board.ts";
import { bundleById } from "./bundle.ts";
import { rewriteForPlatform, toPostVariant } from "./copy.ts";
import { DELIVERABLE_PRICES, refillPriceMicros } from "./estimate.ts";
import { variantContentHash } from "./hash.ts";
import type { EngineDeps } from "./package.ts";
import { hasBlock, sanitizeVariant, validateVariant, type ClaimInfo } from "./validate.ts";

const { campaigns, contentItems, generationRuns, variants, posts, claims } = schema;

/** A refill's own cap: twice its estimate, at least $1 (§7.2 caps apply per run). */
const refillCap = (est: number) => Math.max(1_000_000, est * 2);

export type RefillResult = { ok: true; runId: string; estimateMicros: number; slotIds: string[] } | { ok: false; reason: string };

/**
 * "Open · Make more": new content items for the chosen open slots (or slots whose item failed or was
 * skipped), a refill run (generation_runs kind refill) and the plan updated to point at them. The web
 * route enqueues package.orchestrate for the returned run.
 */
export async function createRefillRun(
  db: Db,
  workspaceId: string,
  campaignId: string,
  slotIds: string[],
  opts: { generators?: readonly GeneratorId[]; now?: Date } = {},
): Promise<RefillResult> {
  const now = opts.now ?? new Date();
  const on = new Set(opts.generators ?? M2_GENERATORS);
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)));
  if (!c?.plan) return { ok: false, reason: "Campaign not found." };
  const plan = structuredClone(c.plan) as unknown as CampaignPlan;
  const items = await db.select().from(contentItems).where(eq(contentItems.campaignId, c.id));
  const byKey = new Map(items.map((i) => [i.deliverableKey, i]));

  const chosen = plan.slots.filter((s) => {
    if (!slotIds.includes(s.id)) return false;
    const gen = KIND_GENERATOR[s.kind];
    if (!gen || !on.has(gen) || new Date(s.scheduledAt).getTime() <= now.getTime()) return false;
    if (s.status === "open") return true;
    const it = s.deliverableKey ? byKey.get(s.deliverableKey) : undefined;
    return !it || it.status === "failed" || it.status === "skipped";
  });
  if (!chosen.length) return { ok: false, reason: "Those slots can't be filled right now." };

  const styleUse = new Map<OpeningStyle, number>(OPENING_STYLES.map((s) => [s, 0]));
  for (const it of plan.items) styleUse.set(it.openingStyle, (styleUse.get(it.openingStyle) ?? 0) + 1);
  const angleUse = new Map<number, number>();
  for (const it of plan.items) angleUse.set(it.angleIdx, (angleUse.get(it.angleIdx) ?? 0) + 1);
  const nRefills = items.filter((i) => i.slotKind === "refill").length;

  const runId = uuidv7();
  const estimate = chosen.reduce((n, s) => n + refillPriceMicros(s.kind), 0);
  const rows: (typeof contentItems.$inferInsert)[] = [];
  chosen.forEach((s, k) => {
    const key = `${s.kind}:${s.lineKey}-r${String(nRefills + k + 1).padStart(2, "0")}`;
    const style = [...OPENING_STYLES].sort((a, b) => styleUse.get(a)! - styleUse.get(b)!)[0]!;
    styleUse.set(style, styleUse.get(style)! + 1);
    // The lead angle unless it's already had more than its 60%.
    const total = [...angleUse.values()].reduce((a, b) => a + b, 0) || 1;
    const angleIdx = (angleUse.get(0) ?? 0) / total > 0.6 && angleUse.size > 1 ? 1 : 0;
    angleUse.set(angleIdx, (angleUse.get(angleIdx) ?? 0) + 1);
    const targets = [{ platform: s.platform as SocialPlatform, format: s.format as PostFormat }];
    const brief: ItemBrief = { schemaVersion: 1, lineKey: s.lineKey, targets, slotIds: [s.id], angleIdx, openingStyle: style, masterIdx: s.masterIdx, launch: s.launch, written: null };
    Object.assign(s, { status: "filled", openReason: null, deliverableKey: key, angleIdx, openingStyle: style });
    const item: PlanItem = {
      deliverableKey: key,
      kind: s.kind,
      generator: KIND_GENERATOR[s.kind]!,
      lineKey: s.lineKey,
      idx: nRefills + k,
      angleIdx,
      openingStyle: style,
      day: s.day,
      slotIds: [s.id],
      targets,
      masterIdx: s.masterIdx,
      launch: s.launch,
    };
    plan.items.push(item);
    rows.push({
      id: uuidv7(),
      workspaceId,
      campaignId: c.id,
      runId,
      deliverableKey: key,
      kind: s.kind,
      slotKind: "refill",
      day: s.day,
      brief: brief as unknown as Record<string, unknown>,
    });
  });

  await db.transaction(async (tx) => {
    await tx.insert(generationRuns).values({
      id: runId,
      workspaceId,
      productId: c.productId,
      kind: "refill",
      status: "queued",
      input: { campaignId: c.id, slotIds: chosen.map((s) => s.id), estimateMicros: estimate },
      capMicros: refillCap(estimate),
    });
    await tx.insert(contentItems).values(rows);
    await tx.update(campaigns).set({ plan: plan as unknown as Record<string, unknown> }).where(eq(campaigns.id, c.id));
  });
  return { ok: true, runId, estimateMicros: estimate, slotIds: chosen.map((s) => s.id) };
}

// ── "Rewrite for this platform · ~$0.005" (copy.rewrite job) ──

export const REWRITE_PRICE_MICROS = DELIVERABLE_PRICES.rewrite;
/** Post states an edit may touch without the publishing state machine's "edit" event. */
const EDITABLE_POST_STATES = ["draft", "pending_approval"] as const;

export async function createRewriteRun(db: Db, workspaceId: string, variantId: string, ask?: string): Promise<string | null> {
  const [v] = await db.select().from(variants).where(and(eq(variants.id, variantId), eq(variants.workspaceId, workspaceId)));
  if (!v) return null;
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, v.contentItemId));
  const [c] = item ? await db.select().from(campaigns).where(eq(campaigns.id, item.campaignId)) : [];
  if (!item || !c) return null;
  const id = uuidv7();
  await db.insert(generationRuns).values({
    id,
    workspaceId,
    productId: c.productId,
    kind: "refill",
    status: "queued",
    input: { action: "rewrite", campaignId: c.id, variantId, ask: ask ?? null },
    capMicros: 200_000,
  });
  return id;
}

export interface RewriteDeps extends Pick<EngineDeps, "db" | "rates" | "client" | "publish" | "now"> {
  /**
   * The publishing state machine's "edit" event for posts past pending_approval (§4.3: back to
   * pending_approval and the delayed job removed). Without it, approved posts block the rewrite.
   */
  onVariantEdited?: (variantId: string) => Promise<void>;
}

/** copy.rewrite: rewrite one text variant for its platform, re-check it, and store it if it passes. */
export async function rewriteVariant(deps: RewriteDeps, runId: string, variantId: string): Promise<{ ok: boolean; message: string }> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, runId));
  if (!run || run.status !== "queued" || run.input.variantId !== variantId) return { ok: false, message: "Already handled." };
  const done = async (status: "completed" | "failed", message: string, extra: Record<string, unknown> = {}) => {
    const spent = await runSpentMicros(db, runId);
    await db.update(generationRuns).set({ status, result: { message, spentMicros: spent, ...extra }, finishedAt: now() }).where(eq(generationRuns.id, runId));
    await deps.publish?.(runId, status === "completed" ? { type: "run_completed" } : { type: "stage_failed", stage: "rewrite", code: "rewrite", message, retryable: true });
    return { ok: status === "completed", message };
  };
  await db.update(generationRuns).set({ status: "running", startedAt: now() }).where(eq(generationRuns.id, runId));

  const [v] = await db.select().from(variants).where(and(eq(variants.id, variantId), eq(variants.workspaceId, run.workspaceId)));
  const parsed = v ? TextVariantBody.safeParse(v.body) : null;
  if (!v || !parsed?.success) return done("failed", "Only text posts can be rewritten here.");
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, v.contentItemId));
  const [c] = item ? await db.select().from(campaigns).where(eq(campaigns.id, item.campaignId)) : [];
  const bundle = c?.bundleId ? await bundleById(db, run.workspaceId, c.bundleId) : null;
  if (!item || !c || !bundle) return done("failed", "This post's campaign is missing.");
  const postRows = await db.select().from(posts).where(eq(posts.variantId, v.id));
  const locked = postRows.filter((p) => !(EDITABLE_POST_STATES as readonly string[]).includes(p.state));
  if (locked.length && !deps.onVariantEdited) return done("failed", "It's already approved. Unapprove it first to rewrite.");

  const body = parsed.data;
  const platform = v.platform as SocialPlatform;
  const brief = item.brief as unknown as ItemBrief;
  const format = brief.targets.find((t) => t.platform === platform)?.format ?? "text";
  try {
    const periods = await budgetScopesForRun(db, run.workspaceId, runId, run.capMicros);
    const r = await rewriteForPlatform(
      { ai: { db, rates: deps.rates, client: deps.client }, workspaceId: run.workspaceId, budgetPeriodIds: periods, runId, bundle: { version: bundle.version, text: bundle.text } },
      { variant: body.variant, platform, format, ask: typeof run.input.ask === "string" ? run.input.ask : undefined },
    );
    const next = toPostVariant({ ...r.value, platform }, platform, body.kind);
    if (!next) return done("failed", "The rewrite came back empty. Try again.");
    const claimRows = await db.select().from(claims).where(eq(claims.dnaVersionId, bundle.dnaVersionId));
    const claimMap = new Map<string, ClaimInfo>(claimRows.map((x) => [x.ref, { ref: x.ref, publicOk: x.publicOk, status: x.status, expiresAt: x.expiresAt }]));
    const at = postRows[0]?.scheduledAt ?? null;
    const plan = c.plan as unknown as CampaignPlan | null;
    const slot = plan?.slots.find((s) => brief.slotIds.includes(s.id) && s.platform === platform);
    const vctx = {
      platform,
      format,
      scheduledAt: at,
      claims: claimMap,
      recentTexts: [],
      xLinksAllowed: !!slot && !!plan && Math.abs(slot.day - plan.launchDay) <= 3,
    };
    const s = sanitizeVariant(next, vctx);
    const issues = [...s.issues, ...validateVariant(s.variant, vctx)];
    if (hasBlock(issues)) return done("completed", issues.find((i) => i.severity === "block")!.message, { kept: true, issues });

    const newBody = { ...body, variant: s.variant };
    await db.transaction(async (tx) => {
      await tx
        .update(variants)
        .set({ body: newBody, qa: { issues, checkedAt: now().toISOString() }, contentHash: variantContentHash({ platform, body: newBody }), updatedAt: now() })
        .where(eq(variants.id, v.id));
      await tx.update(posts).set({ state: "pending_approval", updatedAt: now() }).where(and(eq(posts.variantId, v.id), inArray(posts.state, ["draft"])));
    });
    if (locked.length) await deps.onVariantEdited!(v.id);
    return done("completed", "Rewritten.", { issues });
  } catch (err) {
    if (err instanceof BudgetExceeded) return done("failed", "This would go over your spending limit.");
    if (err instanceof ClaudeRefused) return done("failed", "Claude declined to rewrite this one.");
    if (err instanceof StructuredOutputInvalid) return done("failed", "It came back in the wrong shape twice. Try again.");
    throw err;
  }
}
