import { z } from "zod";
import { formatUsd } from "@mkt/core/cost";
import type { CampaignPlan } from "@mkt/contracts";
import { WEB_GENERATORS, checkMonthLeft, createRefillRun, latestCampaign, refillPriceMicros } from "@mkt/core/engine";
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
  campaignId: z.string().uuid().optional(),
  slotIds: z.array(z.string().min(1).max(64)).min(1).max(60),
});

/** "Open · Make more ~$0.40" (§2.3 Campaign board, D12): fill chosen open slots with a refill run. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json(400, { error: "Pick at least one open slot." });

  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Product not found." });
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });
  const latest = await latestCampaign(db, s.workspaceId, product.id);
  if (!latest) return json(409, { error: "Make your campaign first." });
  if (parsed.data.campaignId && parsed.data.campaignId !== latest.campaign.id) return json(409, { error: "This campaign was replaced. Refresh the page." });
  const campaignId = latest.campaign.id;

  // Priced before anything is created, so a refused refill leaves the slots Open (§7.3).
  const plan = latest.campaign.plan as unknown as CampaignPlan | null;
  const wanted = new Set(parsed.data.slotIds);
  const estimate = (plan?.slots ?? []).filter((x) => wanted.has(x.id)).reduce((n, x) => n + refillPriceMicros(x.kind), 0);
  const budget = await checkMonthLeft(db, s.workspaceId, ws.monthlyLimitMicros, estimate);
  if (!budget.ok) {
    return json(402, {
      error: `This needs about ${formatUsd(estimate)} and you have ${formatUsd(budget.leftMicros)} left this month. Raise your limit to carry on.`,
      code: "over_limit",
    });
  }
  const r = await createRefillRun(db, s.workspaceId, campaignId, parsed.data.slotIds, { generators: WEB_GENERATORS });
  if (!r.ok) return json(409, { error: r.reason });
  await enqueue<"generate", "package.orchestrate">(getQueue("generate"), "package.orchestrate", { runId: r.runId }, {
    jobId: `orch-${r.runId}-${uuidv7()}`,
    dedupe: `orch:${r.runId}`,
  });
  return json(201, { runId: r.runId, estimateMicros: r.estimateMicros, slotIds: r.slotIds });
}
