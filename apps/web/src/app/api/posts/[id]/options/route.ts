import { editPost, loadPost, setMadeForKids, validateTikTokComposer } from "@mkt/core/publishing";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";
import { errorResponse, graceMin, readBody, userActor, UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Save composer options (TikTok audience, toggles, disclosure, direct vs drafts). Options are in
 * the approval hash, so an approved post goes back to waiting for approval (editPost).
 * `madeForKids` is the once-per-project answer and is saved on the project.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Post not found." });
  const body = await readBody(req);
  const opts = body.platformOptions;
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) return json(400, { error: "Nothing to save." });
  if (JSON.stringify(opts).length > 10_000) return json(400, { error: "These options are too large to save." });
  const db = getDb();
  const ws = auth.s.workspaceId;
  try {
    const post = await loadPost(db, ws, id);
    if (!post) return json(404, { error: "Post not found." });
    if (typeof body.madeForKids === "boolean") await setMadeForKids(db, ws, post.productId, body.madeForKids, auth.s.userId);
    const r = await editPost(db, ws, id, { platformOptions: opts as Record<string, unknown> }, userActor(auth.s.userId), {
      graceMin: graceMin(),
    });
    if (r) await applyEffects([r]);
    const issues = post.platform === "tiktok" ? validateTikTokComposer({ options: opts, creatorInfo: null }).issues : [];
    const after = await loadPost(db, ws, id);
    return json(200, { ok: true, state: after?.state ?? post.state, issues });
  } catch (err) {
    return errorResponse(err);
  }
}
