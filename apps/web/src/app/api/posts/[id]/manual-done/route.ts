import { loadPost, markManualPosted, markTikTokDraftDone } from "@mkt/core/publishing";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";
import { errorResponse, publishDeps, readBody, userActor, UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Mark as posted": a post finished in the TikTok app (drafts mode, link optional) or posted by
 * hand after "Download & post yourself" (link to the live post required).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Post not found." });
  const body = await readBody(req);
  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : undefined;
  const ws = auth.s.workspaceId;
  const actor = userActor(auth.s.userId);
  try {
    const post = await loadPost(getDb(), ws, id);
    if (!post) return json(404, { error: "Post not found." });
    if (post.state === "awaiting_user") await markTikTokDraftDone(publishDeps(), ws, id, url, actor);
    else {
      if (!url) return json(400, { error: "Paste the link to the live post." });
      await markManualPosted(publishDeps(), ws, id, url, actor);
    }
    return json(200, { ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
