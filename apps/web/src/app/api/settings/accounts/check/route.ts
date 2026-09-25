import { uuidv7 } from "@mkt/db";
import { enqueue } from "@mkt/core/queue";
import { getQueue } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/** "Check now": the same maint.connections_health job the worker runs every 6 hours. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  try {
    await enqueue<"maint", "maint.connections_health">(getQueue("maint"), "maint.connections_health", {}, { jobId: `health-${uuidv7()}` });
  } catch {
    return json(503, { error: "Couldn't start the check. The server's job queue may be down; try again in a minute." });
  }
  return json(200, { ok: true });
}
