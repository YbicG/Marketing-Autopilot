import { cancelPost } from "@mkt/core/publishing";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";
import { errorResponse, graceMin, userActor, UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cancel a post that hasn't been sent yet. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Post not found." });
  try {
    const r = await cancelPost(getDb(), auth.s.workspaceId, id, userActor(auth.s.userId), { graceMin: graceMin() });
    await applyEffects([r]);
    return json(200, { ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
