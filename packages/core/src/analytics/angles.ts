// Results v0 actions (§2.3 Results, §5.9 v1 learning): Make 5 more for one angle, Stop this angle.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { CampaignPlan, GeneratorId, PlanSlot } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { KIND_GENERATOR } from "../engine/board.ts";
import { refillPriceMicros } from "../engine/estimate.ts";
import { WEB_GENERATORS } from "../engine/package-options.ts";
import { createRefillRun } from "../engine/refill.ts";

const { angles, campaigns, contentItems, strategies } = schema;

export const MAKE_MORE_COUNT = 5;
/** The same generators the campaign board's Make more uses (videos are on from M3a). */
export const RESULTS_GENERATORS: readonly GeneratorId[] = WEB_GENERATORS;

type ItemLite = { deliverableKey: string; status: string };

/**
 * Pure: the next open slots a refill may fill (open, or whose item failed or was skipped), soonest
 * first, only kinds whose generator is on and only in the future. Mirrors createRefillRun's filter.
 */
export function slotsForMore(plan: Pick<CampaignPlan, "slots">, items: ItemLite[], now: Date, n = MAKE_MORE_COUNT, generators: readonly GeneratorId[] = RESULTS_GENERATORS): PlanSlot[] {
  const byKey = new Map(items.map((i) => [i.deliverableKey, i]));
  const on = new Set(generators);
  return plan.slots
    .filter((s) => {
      const gen = KIND_GENERATOR[s.kind];
      if (!gen || !on.has(gen) || s.openReason === "coming_soon" || new Date(s.scheduledAt).getTime() <= now.getTime()) return false;
      if (s.status === "open") return true;
      const it = s.deliverableKey ? byKey.get(s.deliverableKey) : undefined;
      return !it || it.status === "failed" || it.status === "skipped";
    })
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .slice(0, n);
}

async function angleOf(db: Db, workspaceId: string, productId: string, angleId: string) {
  const [a] = await db
    .select({ id: angles.id, idx: angles.idx, status: angles.status, strategyId: angles.strategyId })
    .from(angles)
    .innerJoin(strategies, eq(strategies.id, angles.strategyId))
    .where(and(eq(angles.id, angleId), eq(angles.workspaceId, workspaceId), eq(strategies.productId, productId)));
  return a ?? null;
}

async function latestCampaign(db: Db, workspaceId: string, productId: string) {
  const [c] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.productId, productId)))
    .orderBy(desc(campaigns.createdAt))
    .limit(1);
  return c?.plan ? c : null;
}

/** What "Make 5 more" would fill and cost right now (the price on the button). */
export async function makeMoreEstimate(db: Db, workspaceId: string, productId: string, now = new Date()): Promise<{ count: number; estimateMicros: number }> {
  const c = await latestCampaign(db, workspaceId, productId);
  if (!c) return { count: 0, estimateMicros: 0 };
  const items = await db.select({ deliverableKey: contentItems.deliverableKey, status: contentItems.status }).from(contentItems).where(eq(contentItems.campaignId, c.id));
  const slots = slotsForMore(c.plan as unknown as CampaignPlan, items, now);
  return { count: slots.length, estimateMicros: slots.reduce((n, s) => n + refillPriceMicros(s.kind), 0) };
}

export type MakeMoreResult = { ok: true; runId: string; estimateMicros: number; count: number } | { ok: false; reason: string };

/**
 * "Make 5 more" for one angle: a refill run over the next open slots, then the new items are
 * pointed at that angle (createRefillRun picks the lead angle itself and leaves angle_id empty,
 * so Results would never count them). The route enqueues package.orchestrate for the run.
 */
export async function makeMoreForAngle(db: Db, workspaceId: string, productId: string, angleId: string, now = new Date()): Promise<MakeMoreResult> {
  const angle = await angleOf(db, workspaceId, productId, angleId);
  if (!angle) return { ok: false, reason: "That angle isn't there any more." };
  if (angle.status === "stopped") return { ok: false, reason: "This angle is stopped. Start it again first." };
  const c = await latestCampaign(db, workspaceId, productId);
  if (!c) return { ok: false, reason: "Make your campaign first, then add more posts here." };
  const items = await db.select({ deliverableKey: contentItems.deliverableKey, status: contentItems.status }).from(contentItems).where(eq(contentItems.campaignId, c.id));
  const slots = slotsForMore(c.plan as unknown as CampaignPlan, items, now);
  if (!slots.length) return { ok: false, reason: "There are no open days left in this campaign's 30 days." };

  const r = await createRefillRun(db, workspaceId, c.id, slots.map((s) => s.id), { generators: RESULTS_GENERATORS, now });
  if (!r.ok) return r;

  const created = await db.select().from(contentItems).where(and(eq(contentItems.runId, r.runId), eq(contentItems.workspaceId, workspaceId)));
  const keys = new Set(created.map((i) => i.deliverableKey));
  await db.transaction(async (tx) => {
    for (const it of created) {
      await tx
        .update(contentItems)
        .set({ angleId: angle.id, brief: { ...(it.brief ?? {}), angleIdx: angle.idx } })
        .where(eq(contentItems.id, it.id));
    }
    const [fresh] = await tx.select({ plan: campaigns.plan }).from(campaigns).where(eq(campaigns.id, c.id));
    const plan = fresh?.plan as unknown as CampaignPlan | null;
    if (plan) {
      for (const it of plan.items) if (keys.has(it.deliverableKey)) it.angleIdx = angle.idx;
      for (const s of plan.slots) if (s.deliverableKey && keys.has(s.deliverableKey)) s.angleIdx = angle.idx;
      await tx.update(campaigns).set({ plan: plan as unknown as Record<string, unknown> }).where(eq(campaigns.id, c.id));
    }
  });
  return { ok: true, runId: r.runId, estimateMicros: r.estimateMicros, count: created.length };
}

/** "Stop this angle" (and start it again). Workspace- and product-scoped; false when not found. */
export async function setAngleStatus(db: Db, workspaceId: string, productId: string, angleId: string, status: "active" | "stopped"): Promise<boolean> {
  const angle = await angleOf(db, workspaceId, productId, angleId);
  if (!angle) return false;
  const res = await db
    .update(angles)
    .set({ status })
    .where(and(eq(angles.id, angle.id), eq(angles.workspaceId, workspaceId), inArray(angles.strategyId, [angle.strategyId])))
    .returning({ id: angles.id });
  return res.length > 0;
}
