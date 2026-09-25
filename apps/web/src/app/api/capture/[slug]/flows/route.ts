import { CaptureFlow } from "@mkt/contracts";
import { createFlow } from "@mkt/core/capture";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { captureAuth, captureError, readJson } from "../../_lib/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Add a flow by hand. Flows that log in or fill in a form still need the confirm click. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const auth = await captureAuth(req, slug);
  if (!auth.ok) return auth.res;
  const parsed = CaptureFlow.safeParse((await readJson(req)).flow);
  if (!parsed.success) return json(400, { error: "That flow has a step the recorder can't follow. Check each step has what it needs." });
  try {
    const id = await createFlow(getDb(), auth.s.workspaceId, auth.product.id, parsed.data);
    return json(201, { flowId: id });
  } catch (err) {
    return captureError(err);
  }
}
