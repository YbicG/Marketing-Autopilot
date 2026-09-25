import { z } from "zod";
import { PackageTier, SocialPlatform, type ProductKind } from "@mkt/contracts";
import { formatUsd } from "@mkt/core/cost";
import { WEB_GENERATORS, buildRecipe, checkMonthLeft, createPackageRun, estimatePackage } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { enqueue } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  tier: PackageTier.default("standard"),
  platforms: z.array(SocialPlatform).min(1).max(7).optional(),
});

/**
 * "Make my campaign · ~$7" (§2.3, §5.3): freeze the bundle, plan 30 days, create the package run,
 * then hand it to package.orchestrate. Refused up front when the high estimate is more than what's
 * left of the month (§7.3), with the cheaper tier's price so the page can offer "Switch to Quick".
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json(400, { error: "Pick a package and at least one place to post." });
  const { tier, platforms } = parsed.data;

  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Product not found." });
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });

  const kind = product.kind as ProductKind;
  const estimate = estimatePackage(buildRecipe(kind, tier, { generators: WEB_GENERATORS, platforms }));
  const budget = await checkMonthLeft(db, s.workspaceId, ws.monthlyLimitMicros, estimate.high);
  if (!budget.ok) {
    const quick = estimatePackage(buildRecipe(kind, "quick", { generators: WEB_GENERATORS, platforms }));
    return json(402, {
      error: `This package could cost up to ${formatUsd(estimate.high)}, and you have ${formatUsd(budget.leftMicros)} left this month. Switch to Quick or raise your limit.`,
      code: "over_limit",
      quickFits: tier !== "quick" && quick.high <= budget.leftMicros,
    });
  }

  const created = await createPackageRun(db, s.workspaceId, product.id, tier, { generators: WEB_GENERATORS, platforms });
  if (!created) return json(409, { error: "Pick your angles first: your plan needs them before we can write the campaign." });
  await enqueue<"generate", "package.orchestrate">(getQueue("generate"), "package.orchestrate", { runId: created.runId }, {
    jobId: `orch-${created.runId}-${uuidv7()}`,
    dedupe: `orch:${created.runId}`,
  });
  return json(201, { runId: created.runId, campaignId: created.campaignId, href: `/p/${encodeURIComponent(product.slug)}/content` });
}
