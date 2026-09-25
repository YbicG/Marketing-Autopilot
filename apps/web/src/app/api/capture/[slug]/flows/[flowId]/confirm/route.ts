import { confirmFlow, getFlow } from "@mkt/core/capture";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { captureAuth, UUID } from "../../../../_lib/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The one confirm click for a flow that logs in or fills in a form (D26). UI session only. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; flowId: string }> }) {
  const { slug, flowId } = await ctx.params;
  const auth = await captureAuth(req, slug, { ui: true });
  if (!auth.ok) return auth.res;
  if (!UUID.test(flowId)) return json(404, { error: "That flow isn't there any more." });
  const db = getDb();
  const flow = await getFlow(db, auth.s.workspaceId, flowId);
  if (!flow || flow.productId !== auth.product.id) return json(404, { error: "That flow isn't there any more." });
  await confirmFlow(db, auth.s.workspaceId, auth.s.userId, flowId);
  return json(200, { confirmed: true });
}
