import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { PackageTier, SocialPlatform, type ProductKind } from "@mkt/contracts";
import { schema } from "@mkt/db";
import { formatUsd } from "../cost/pricing.ts";
import { estimatePackage } from "../engine/estimate.ts";
import { WEB_GENERATORS, checkMonthLeft } from "../engine/package-options.ts";
import { createPackageRun } from "../engine/package.ts";
import { buildRecipe } from "../engine/recipe.ts";
import { getWorkspace } from "../tenancy/index.ts";
import { ProductSlug, productOf } from "./read-tools.ts";
import { defineTool, ToolError, type ToolRunCtx } from "./registry.ts";

const { generationRuns } = schema;

// Spend tools (§9, D10). The price is worked out before anything runs; over the token's limits the
// call comes back pending_confirmation with a link for the owner, and only a UI confirm lets it through.

const PackageIn = z.object({
  product: ProductSlug,
  tier: PackageTier.default("standard").describe("quick, standard or premium"),
  platforms: z.array(SocialPlatform).min(1).max(7).optional().describe("Where to post; the product's usual places if left out"),
});
type PackageIn = z.infer<typeof PackageIn>;

async function priceOf(ctx: Pick<ToolRunCtx, "db" | "pat">, input: PackageIn) {
  const p = await productOf(ctx, input.product);
  const recipe = buildRecipe(p.kind as ProductKind, input.tier, { generators: WEB_GENERATORS, platforms: input.platforms });
  return { product: p, platforms: recipe.platforms, estimate: estimatePackage(recipe) };
}

/** Free: the same numbers the app shows on "Make my campaign". */
export const estimatePackageTool = defineTool({
  name: "estimate_package",
  description: "What a 30-day campaign package for a product would cost (expected and at most), without starting it. Free.",
  input: PackageIn,
  output: z.custom<{ tier: string; platforms: string[]; expectedMicros: number; highMicros: number; expected: string; atMost: string }>(),
  effect: "read",
  scopes: ["read"],
  async run(ctx, input) {
    const { estimate, platforms } = await priceOf(ctx, input);
    return {
      tier: input.tier,
      platforms,
      expectedMicros: estimate.expected,
      highMicros: estimate.high,
      expected: formatUsd(estimate.expected),
      atMost: formatUsd(estimate.high),
    };
  },
});

export const runPackage = defineTool({
  name: "run_package",
  description:
    "Start a 30-day campaign package for a product (it writes the posts, swipe posts and videos as drafts). Costs money: over $0.50, or past this token's $10 this month, it comes back pending_confirmation with a link the owner opens to confirm. Returns a jobId to follow with get_job.",
  input: PackageIn,
  output: z.custom<{ jobId: string; campaignId: string; highMicros: number }>(),
  effect: "spend",
  scopes: ["generate"],
  // The high estimate: it's the most the run may spend (its reservation), so it's what's confirmed.
  estimate: async (ctx, input) => (await priceOf(ctx, input)).estimate.high,
  async run(ctx, input) {
    const { db, pat } = ctx;
    const { product, estimate } = await priceOf(ctx, input);
    const ws = await getWorkspace(db, pat.workspaceId);
    if (!ws?.onboardedAt) throw new ToolError("conflict", "The owner hasn't set a monthly spending limit yet.");
    const budget = await checkMonthLeft(db, pat.workspaceId, ws.monthlyLimitMicros, estimate.high);
    if (!budget.ok) {
      throw new ToolError("over_limit", `This could cost up to ${formatUsd(estimate.high)}, and the workspace has ${formatUsd(budget.leftMicros)} left this month.`);
    }
    const created = await createPackageRun(db, pat.workspaceId, product.id, input.tier, { generators: WEB_GENERATORS, platforms: input.platforms, now: ctx.now });
    if (!created) throw new ToolError("conflict", "The product's angles aren't picked yet. The owner picks them on the plan screen first.");
    // Who started it: an unconfirmed run also reserves against this token's own month (budgetScopesForRun).
    await db
      .update(generationRuns)
      .set({ input: sql`${generationRuns.input} || ${JSON.stringify({ agent: { patId: pat.patId, confirmed: ctx.confirmed } })}::jsonb` })
      .where(eq(generationRuns.id, created.runId));
    await ctx.deps.enqueueOrchestrate(created.runId);
    return { jobId: created.runId, campaignId: created.campaignId, highMicros: estimate.high };
  },
});

export const SPEND_TOOLS = [estimatePackageTool, runPackage];
