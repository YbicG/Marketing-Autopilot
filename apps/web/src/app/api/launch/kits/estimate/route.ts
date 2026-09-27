import { formatUsd } from "@mkt/core/cost";
import { planKitRun } from "@mkt/core/launch";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { kitErrorResponse, readBody, UUID } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Write it · ~$x" before anything is created (§7.1 step 1). Nothing is spent or saved. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const body = await readBody(req);
  const launchPlanId = typeof body.launchPlanId === "string" ? body.launchPlanId : "";
  if (!UUID.test(launchPlanId)) return json(404, { error: "Launch plan not found." });
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k): k is string => typeof k === "string") : [];
  try {
    const est = await planKitRun(getDb(), s.workspaceId, { launchPlanId, kinds, inputs: body.inputs });
    if (!est) return json(404, { error: "Launch plan not found." });
    return json(200, { ...est, expectedLabel: formatUsd(est.expected), highLabel: formatUsd(est.high) });
  } catch (err) {
    return kitErrorResponse(err);
  }
}
