import { makeMoreEstimate, makeMoreForAngle } from "@mkt/core/analytics";
import { formatUsd } from "@mkt/core/cost";
import { checkMonthLeft } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { enqueue } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Results "Make 5 more" for one angle: a refill run over the next open days, on that angle. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const body = (await req.json().catch(() => ({}))) as { angleId?: unknown };
  const angleId = typeof body.angleId === "string" && UUID.test(body.angleId) ? body.angleId : null;
  if (!angleId) return json(400, { error: "Pick an angle first." });

  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Project not found." });
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });

  // Priced before anything is created, so a refused request changes nothing.
  const { estimateMicros } = await makeMoreEstimate(db, s.workspaceId, product.id);
  const budget = await checkMonthLeft(db, s.workspaceId, ws.monthlyLimitMicros, estimateMicros);
  if (!budget.ok) {
    return json(402, {
      error: `This needs about ${formatUsd(estimateMicros)} and you have ${formatUsd(budget.leftMicros)} left this month. Raise your limit to carry on.`,
      code: "over_limit",
    });
  }
  const r = await makeMoreForAngle(db, s.workspaceId, product.id, angleId);
  if (!r.ok) return json(409, { error: r.reason });
  await enqueue<"generate", "package.orchestrate">(getQueue("generate"), "package.orchestrate", { runId: r.runId }, {
    jobId: `orch-${r.runId}-${uuidv7()}`,
    dedupe: `orch:${r.runId}`,
  });
  return json(201, { runId: r.runId, count: r.count, estimateMicros: r.estimateMicros });
}
