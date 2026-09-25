import { approvePosts, markVideoItemsApproved } from "@mkt/core/publishing";
import { errorResponse, graceMin, readBody, UUID } from "@/app/api/posts/_shared";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** D9: approve posts. Only a signed-in person in the web UI (cookie + Origin + CSRF header). */
export async function POST(req: Request) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const body = await readBody(req);
  const postIds = Array.isArray(body.postIds) ? body.postIds.filter((x): x is string => typeof x === "string" && UUID.test(x)) : [];
  if (!postIds.length) return json(400, { error: "Pick at least one post to approve." });
  if (postIds.length > 500) return json(400, { error: "Approve at most 500 posts at a time." });
  try {
    const r = await approvePosts(getDb(), auth.ui, postIds, { graceMin: graceMin() });
    await applyEffects(r.effects);
    await markVideoItemsApproved(getDb(), auth.ui.workspaceId, r.approved.map((a) => a.postId));
    return json(200, { approved: r.approved.length, skipped: r.skipped });
  } catch (err) {
    return errorResponse(err);
  }
}
