import { CaptureFlow } from "@mkt/contracts";
import { deleteFlow, getFlow, updateFlow } from "@mkt/core/capture";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { captureAuth, captureError, readJson, UUID } from "../../../_lib/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string; flowId: string }> };

async function ownFlow(req: Request, ctx: Ctx) {
  const { slug, flowId } = await ctx.params;
  const auth = await captureAuth(req, slug);
  if (!auth.ok) return auth;
  if (!UUID.test(flowId)) return { ok: false as const, res: json(404, { error: "That flow isn't there any more." }) };
  const flow = await getFlow(getDb(), auth.s.workspaceId, flowId);
  if (!flow || flow.productId !== auth.product.id) return { ok: false as const, res: json(404, { error: "That flow isn't there any more." }) };
  return { ...auth, flowId };
}

/** Edit a flow's steps. Any edit clears its confirmation: check it and confirm again. */
export async function POST(req: Request, ctx: Ctx) {
  const got = await ownFlow(req, ctx);
  if (!got.ok) return got.res;
  const parsed = CaptureFlow.safeParse((await readJson(req)).flow);
  if (!parsed.success) return json(400, { error: "That flow has a step the recorder can't follow. Check each step has what it needs." });
  try {
    await updateFlow(getDb(), got.s.workspaceId, got.flowId, parsed.data);
    return json(200, { flowId: got.flowId });
  } catch (err) {
    return captureError(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const got = await ownFlow(req, ctx);
  if (!got.ok) return got.res;
  await deleteFlow(getDb(), got.s.workspaceId, got.flowId);
  return json(200, { deleted: true });
}
