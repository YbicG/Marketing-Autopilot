import { and, desc, eq } from "drizzle-orm";
import { PACKAGE_TIERS, type GeneratorId, type PackageTier, type ProductKind, type SocialPlatform } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { monthSpend } from "../cost/ledger.ts";
import { estimatePackage } from "./estimate.ts";
import { buildRecipe } from "./recipe.ts";

const { campaigns, generationRuns } = schema;

// "Make my campaign · ~$X" (§2.3 Here's your plan, §2.5 packages, §7.3 cap modal).

/** Generators the web app switches on for new packages (M3a turns on video). */
export const WEB_GENERATORS: readonly GeneratorId[] = ["posts", "threads", "carousel", "bio", "video"];

export const TIER_LABELS: Record<PackageTier, string> = { quick: "Quick", standard: "Standard", premium: "Premium" };

export interface TierEstimate {
  expected: number;
  high: number;
  capMicros: number;
}

export interface PackageOptions {
  /** The recipe's platforms for this kind of product, in order. */
  platforms: SocialPlatform[];
  /** Keyed `${tier}|${platforms sorted, comma-joined}`: every tier × platform subset, so the client can update the price without core. */
  estimates: Record<string, TierEstimate>;
}

export const estimateKey = (tier: PackageTier, platforms: readonly string[]) => `${tier}|${[...platforms].sort().join(",")}`;

/** Pure: estimates for every tier and every non-empty subset of the recipe's platforms. */
export function packageOptions(kind: ProductKind, generators: readonly GeneratorId[] = WEB_GENERATORS): PackageOptions {
  const platforms = buildRecipe(kind, "standard", { generators }).platforms;
  const estimates: Record<string, TierEstimate> = {};
  for (let mask = 1; mask < 1 << platforms.length; mask++) {
    const subset = platforms.filter((_, i) => mask & (1 << i));
    for (const tier of PACKAGE_TIERS) {
      const e = estimatePackage(buildRecipe(kind, tier, { generators, platforms: subset }));
      estimates[estimateKey(tier, subset)] = { expected: e.expected, high: e.high, capMicros: e.capMicros };
    }
  }
  return { platforms, estimates };
}

export type BudgetCheck = { ok: true; leftMicros: number } | { ok: false; leftMicros: number; message: string };

/** §7.3: a run may not start when its high estimate is more than what's left of the month. */
export async function checkMonthLeft(db: Db, workspaceId: string, limitMicros: number, highMicros: number): Promise<BudgetCheck> {
  const m = await monthSpend(db, workspaceId, limitMicros);
  const left = Math.max(0, m.capMicros - m.spentMicros - m.reservedMicros);
  if (highMicros <= left) return { ok: true, leftMicros: left };
  return { ok: false, leftMicros: left, message: "This could go over what's left of your monthly spending limit." };
}

/** The product's newest campaign and its package run, for the plan button and the board. */
export async function latestCampaign(db: Db, workspaceId: string, productId: string) {
  const [c] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.productId, productId)))
    .orderBy(desc(campaigns.createdAt))
    .limit(1);
  if (!c) return null;
  const [run] = c.runId
    ? await db
        .select({ id: generationRuns.id, status: generationRuns.status, error: generationRuns.error })
        .from(generationRuns)
        .where(and(eq(generationRuns.id, c.runId), eq(generationRuns.workspaceId, workspaceId)))
    : [];
  return { campaign: c, run: run ?? null };
}

/** Refill / rewrite runs of a campaign still going, newest first (board live progress). */
export async function activeCampaignRuns(db: Db, workspaceId: string, productId: string, campaignId: string) {
  const rows = await db
    .select({ id: generationRuns.id, kind: generationRuns.kind, status: generationRuns.status, input: generationRuns.input, error: generationRuns.error })
    .from(generationRuns)
    .where(and(eq(generationRuns.workspaceId, workspaceId), eq(generationRuns.productId, productId)))
    .orderBy(desc(generationRuns.createdAt))
    .limit(30);
  return rows.filter(
    (r) =>
      (r.kind === "package" || r.kind === "refill") &&
      r.input.campaignId === campaignId &&
      r.input.action !== "rewrite" &&
      (r.status === "queued" || r.status === "running" || r.status === "paused_budget"),
  );
}
