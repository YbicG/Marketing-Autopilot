import { loadPost, moveToDay, reschedulePost, zonedTime } from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";
import { errorResponse, graceMin, readBody, userActor, UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Drag-to-reschedule ({day}: same local time on another day), a picked time ({day, time} in the
 * workspace time zone) or an exact {scheduledAt}. Also "Reschedule" on a missed post, which lets
 * it go out again, so it needs the UI session (D9).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Post not found." });
  const body = await readBody(req);
  const db = getDb();
  const ws = await getWorkspace(db, auth.s.workspaceId);
  const tz = ws?.timezone ?? "UTC";

  let at: Date;
  try {
    if (typeof body.scheduledAt === "string") {
      at = new Date(body.scheduledAt);
      if (Number.isNaN(at.getTime())) return json(400, { error: "Pick a day and a time." });
    } else if (typeof body.day === "string" && DAY.test(body.day)) {
      if (typeof body.time === "string") at = zonedTime(body.day, body.time, tz);
      else {
        const post = await loadPost(db, auth.s.workspaceId, id);
        if (!post) return json(404, { error: "Post not found." });
        at = moveToDay(post.scheduledAt, body.day, tz);
      }
    } else {
      return json(400, { error: "Pick a day and a time." });
    }
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : "Pick a day and a time." });
  }

  try {
    const r = await reschedulePost(db, auth.s.workspaceId, id, at, userActor(auth.s.userId), { graceMin: graceMin() });
    await applyEffects([r]);
    return json(200, { ok: true, scheduledAt: at.toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
