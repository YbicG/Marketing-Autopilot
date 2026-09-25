import { VideoSpec } from "@mkt/contracts";
import { createVideoActionRun, finishVideoActionRun, latestSpec, loadVideoContext, saveVideoEdit } from "@mkt/core/video";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { readJson, UUID, videoDeps, videoError } from "../../_lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Re-voicing a few changed lines on the draft model costs cents; this caps a runaway edit. */
const EDIT_CAP_MICROS = 500_000;

/**
 * Save an edit (§2.3 Video editor): a new spec version, changed spoken lines re-voiced on the draft
 * model, approvals voided if the final files would change. Also "Apply" for Ask for changes.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "That video isn't there any more." });
  const body = await readJson(req);
  const parsed = VideoSpec.safeParse(body.spec);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join(" › ")})` : "";
    return json(400, { error: `That change doesn't fit the video${where}: ${first?.message ?? "check the fields"}. Fix it and save again.` });
  }

  const db = getDb();
  try {
    await loadVideoContext(db, s.workspaceId, id);
    const current = await latestSpec(db, s.workspaceId, id);
    if (!current) return json(409, { error: "This video is still being written. Try again when it's ready." });
    if (typeof body.baseSpecId === "string" && body.baseSpecId !== current.id) {
      return json(409, { error: "This video changed in another tab. Refresh the page and make your change again." });
    }
    const runId = await createVideoActionRun(db, { workspaceId: s.workspaceId, contentItemId: id, action: "video_edit", capMicros: EDIT_CAP_MICROS });
    try {
      const deps = await videoDeps(s.workspaceId);
      const out = await saveVideoEdit(deps, {
        runId,
        workspaceId: s.workspaceId,
        contentItemId: id,
        spec: parsed.data,
        editedBy: body.source === "change_request" ? "model" : "user",
      });
      await finishVideoActionRun(db, s.workspaceId, runId, true, "Saved.");
      return json(200, { specId: out.specId, issues: out.issues });
    } catch (err) {
      await finishVideoActionRun(db, s.workspaceId, runId, false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    return videoError(err);
  }
}
