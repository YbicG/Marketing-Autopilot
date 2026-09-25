import type { VideoSpec } from "@mkt/contracts";
import { formatUsd } from "@mkt/core/cost";
import { checkMonthLeft } from "@mkt/core/engine";
import { enqueue } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { confirmFinalize, createVideoActionRun, latestSpec, loadVideoContext, type AudioPlan, type SpecMeta } from "@mkt/core/video";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";
import { finalizeEstimate, readJson, UUID, videoDeps, videoError } from "../../_lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Gate 1 (D16): "Finalize 3 versions · ~$0.70". A person in the web UI confirms the spend for the
 * exact spec they were shown (its finalize hash), then video.finalize runs on the worker.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { s } = auth;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "That video isn't there any more." });
  const body = await readJson(req);
  const shownHash = typeof body.shownHash === "string" ? body.shownHash : "";
  if (!shownHash) return json(400, { error: "Refresh the page and click Finalize again." });

  const db = getDb();
  try {
    const v = await loadVideoContext(db, s.workspaceId, id);
    if (v.item.status === "finalizing") return json(409, { error: "This video is already being finalized." });
    const row = await latestSpec(db, s.workspaceId, id);
    if (!row) return json(409, { error: "This video is still being written. Try again when it's ready." });
    const ws = await getWorkspace(db, s.workspaceId);
    if (!ws) return json(401, { error: "Sign in again." });

    const deps = await videoDeps(s.workspaceId);
    const plan = (row.lint as unknown as SpecMeta | null)?.audio as unknown as AudioPlan | undefined;
    const estimate = finalizeEstimate(deps.audio, row.spec as unknown as VideoSpec, plan?.lines ?? {});
    const budget = await checkMonthLeft(db, s.workspaceId, ws.monthlyLimitMicros, estimate);
    if (!budget.ok) {
      return json(402, { error: `Finalizing needs about ${formatUsd(estimate)} and you have ${formatUsd(budget.leftMicros)} left this month. Raise your limit in Settings → Spending to carry on.` });
    }

    // Throws FinalizeNotConfirmed when the spec changed since the page was drawn.
    await confirmFinalize(db, { workspaceId: s.workspaceId, contentItemId: id, userId: s.userId, shownHash });
    // Room for re-takes (≤2 per line) and a music retry on top of the estimate.
    const runId = await createVideoActionRun(db, { workspaceId: s.workspaceId, contentItemId: id, action: "finalize", capMicros: Math.max(250_000, estimate * 2), extra: { estimateMicros: estimate } });
    await enqueue<"generate", "video.finalize">(getQueue("generate"), "video.finalize", { runId, contentItemId: id }, { jobId: `fin-${id}-${uuidv7()}` });
    return json(202, { runId, estimateMicros: estimate });
  } catch (err) {
    return videoError(err);
  }
}
