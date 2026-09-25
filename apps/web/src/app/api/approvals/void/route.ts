import { voidApproval } from "@mkt/core/publishing";
import { errorResponse, graceMin, readBody, userActor, UUID } from "@/app/api/posts/_shared";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Take an approval back: the post returns to waiting for approval and its delayed job is removed. */
export async function POST(req: Request) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const body = await readBody(req);
  const postId = typeof body.postId === "string" && UUID.test(body.postId) ? body.postId : null;
  if (!postId) return json(400, { error: "Pick a post." });
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "You took the approval back";
  try {
    const r = await voidApproval(getDb(), auth.s.workspaceId, postId, reason, userActor(auth.s.userId), { graceMin: graceMin() });
    if (!r) return json(404, { error: "That post is gone. Refresh the page." });
    await applyEffects([r]);
    return json(200, { ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
