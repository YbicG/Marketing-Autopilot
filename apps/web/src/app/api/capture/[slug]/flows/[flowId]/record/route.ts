import { getFlow, refreshFootage, type CaptureGateway } from "@mkt/core/capture";
import { enqueue } from "@mkt/core/queue";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { json } from "@/lib/session";
import { captureAuth, captureError, UUID } from "../../../../_lib/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * capture.flow on the render queue. refreshFootage's own jobId has a timestamp in it; a uuid keeps
 * two quick clicks from colliding, and the worker's semaphore keeps them from running together.
 */
const gateway: CaptureGateway = {
  async enqueueCaptureFlow(data) {
    await enqueue<"render", "capture.flow">(getQueue("render"), "capture.flow", data, { jobId: `cap-${data.flowId}-${uuidv7()}` });
  },
};

/** "Record" / "Refresh footage": re-run a saved flow against the demo site. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; flowId: string }> }) {
  const { slug, flowId } = await ctx.params;
  const auth = await captureAuth(req, slug);
  if (!auth.ok) return auth.res;
  if (!UUID.test(flowId)) return json(404, { error: "That flow isn't there any more." });
  const db = getDb();
  const flow = await getFlow(db, auth.s.workspaceId, flowId);
  if (!flow || flow.productId !== auth.product.id) return json(404, { error: "That flow isn't there any more." });
  try {
    await refreshFootage({ db, gateway }, auth.s.workspaceId, flowId);
    return json(202, { queued: true });
  } catch (err) {
    return captureError(err);
  }
}
