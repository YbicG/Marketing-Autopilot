import { ensureVideoPosts, loadVideoContext } from "@mkt/core/video";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { UUID, videoError } from "../../_lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Gate 2 prep: one pending post per final file, at its planned slot (finalize writes the files but
 * no posts). This approves nothing: the page then sends the ids to /api/approvals/posts.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "That video isn't there any more." });
  const db = getDb();
  try {
    const v = await loadVideoContext(db, s.workspaceId, id);
    if (v.item.status !== "final_ready" && v.item.status !== "approved") {
      return json(409, { error: "Finalize this video first. Its final files aren't ready yet." });
    }
    const out = await ensureVideoPosts(db, s.workspaceId, id);
    if (!out.postIds.length && !out.unscheduled.length) return json(409, { error: "There's nothing waiting for approval on this video." });
    return json(200, out);
  } catch (err) {
    return videoError(err);
  }
}
