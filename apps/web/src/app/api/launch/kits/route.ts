import { formatUsd } from "@mkt/core/cost";
import { checkMonthLeft } from "@mkt/core/engine";
import { createKitRun, planKitRun } from "@mkt/core/launch";
import { enqueue } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { kitErrorResponse, readBody, UUID } from "./_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Write it · ~$x" / "Write all · ~$x" (§5.4 LC launch kit): refuse up front when the high estimate
 * is more than what's left of the month (§7.3), create the kit rows + run(s), then one launch.kit
 * job per kit. Nothing is posted or sent from here.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const body = await readBody(req);
  const launchPlanId = typeof body.launchPlanId === "string" ? body.launchPlanId : "";
  if (!UUID.test(launchPlanId)) return json(404, { error: "Launch plan not found." });
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k): k is string => typeof k === "string") : [];

  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });
  try {
    const est = await planKitRun(db, s.workspaceId, { launchPlanId, kinds, inputs: body.inputs });
    if (!est) return json(404, { error: "Launch plan not found." });
    const budget = await checkMonthLeft(db, s.workspaceId, ws.monthlyLimitMicros, est.high);
    if (!budget.ok) {
      return json(402, {
        error: `This could cost up to ${formatUsd(est.high)}, and you have ${formatUsd(budget.leftMicros)} left this month. Write fewer parts or raise your limit.`,
        code: "over_limit",
      });
    }
    const created = await createKitRun(db, s.workspaceId, { launchPlanId, kinds, inputs: body.inputs, userId: s.userId });
    if (!created) return json(404, { error: "Launch plan not found." });
    const q = getQueue("generate");
    for (const k of created.kits) {
      await enqueue<"generate", "launch.kit">(q, "launch.kit", { runId: k.runId, kitId: k.kitId }, { jobId: `kit-${k.kitId}-${uuidv7()}` });
    }
    return json(201, { runId: created.runId, runIds: created.runIds, kits: created.kits, expectedLabel: formatUsd(created.estimate.expected) });
  } catch (err) {
    return kitErrorResponse(err);
  }
}
