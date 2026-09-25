import { loadRateCards, rateLookup } from "@mkt/core/cost";
import { askForChanges, createVideoActionRun, estimateChangeRequestMicros, finishVideoActionRun, latestSpec, loadVideoContext } from "@mkt/core/video";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { readJson, specTools, UUID, videoError } from "../../_lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Ask for changes" (video.change_request, Sonnet): a plain-English request becomes a proposed spec
 * and its diff, checked by lintSpec. Nothing is saved here; "Apply" posts the spec to ../spec.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "That video isn't there any more." });
  const body = await readJson(req);
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (request.length < 3) return json(400, { error: "Say what you'd like changed, like “make the second scene shorter”." });
  if (request.length > 2_000) return json(400, { error: "Keep the request under 2,000 characters." });

  const db = getDb();
  try {
    await loadVideoContext(db, s.workspaceId, id);
    const row = await latestSpec(db, s.workspaceId, id);
    if (!row) return json(409, { error: "This video is still being written. Try again when it's ready." });
    const rates = rateLookup(await loadRateCards(db));
    const estimate = estimateChangeRequestMicros(rates, JSON.stringify(row.spec).length);
    const runId = await createVideoActionRun(db, { workspaceId: s.workspaceId, contentItemId: id, action: "change_request", capMicros: Math.max(150_000, estimate * 3) });
    try {
      const out = await askForChanges({ db, rates, tools: specTools }, { runId, workspaceId: s.workspaceId, contentItemId: id, request });
      await finishVideoActionRun(db, s.workspaceId, runId, true, `${out.diff.length} change${out.diff.length === 1 ? "" : "s"} proposed.`);
      return json(200, { baseSpecId: row.id, spec: out.spec, diff: out.diff, issues: out.issues });
    } catch (err) {
      await finishVideoActionRun(db, s.workspaceId, runId, false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    return videoError(err);
  }
}
