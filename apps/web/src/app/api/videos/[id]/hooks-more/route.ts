import { loadRateCards, rateLookup } from "@mkt/core/cost";
import { createVideoActionRun, estimateHooksMoreMicros, finishVideoActionRun, loadVideoContext, moreOpeningLines } from "@mkt/core/video";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { UUID, videoDeps, videoError } from "../../_lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Write 3 more · ~$0.03" (video.hooks_more, Opus): 3 more opening lines to pick from. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "That video isn't there any more." });

  const db = getDb();
  try {
    await loadVideoContext(db, s.workspaceId, id);
    const estimate = estimateHooksMoreMicros(rateLookup(await loadRateCards(db)));
    // The run cap is the stop: three times the estimate, at least 10 cents.
    const runId = await createVideoActionRun(db, { workspaceId: s.workspaceId, contentItemId: id, action: "hooks_more", capMicros: Math.max(100_000, estimate * 3) });
    try {
      const more = await moreOpeningLines(await videoDeps(s.workspaceId), { runId, workspaceId: s.workspaceId, contentItemId: id });
      await finishVideoActionRun(db, s.workspaceId, runId, true, `${more.length} more opening lines.`);
      return json(200, { more });
    } catch (err) {
      await finishVideoActionRun(db, s.workspaceId, runId, false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    return videoError(err);
  }
}
