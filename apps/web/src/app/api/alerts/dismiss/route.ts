import { dismissAlerts } from "@mkt/core/cost";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/** §7.1 step 7: hide this workspace's open budget alerts until the next threshold is crossed. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  await dismissAlerts(getDb(), s.workspaceId);
  return json(200, { ok: true });
}
