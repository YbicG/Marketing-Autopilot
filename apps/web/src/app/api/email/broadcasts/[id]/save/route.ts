import { saveBroadcast } from "@mkt/core/email";
import { localDay, zonedTime } from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { answer, readBody, UUID, writeSession } from "../../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIELDS = ["name", "subject", "preheader", "body", "claimRefs", "audienceId", "audienceLabel"] as const;

/**
 * Editor save. The send time arrives as a local day + time in the workspace's time zone and is
 * converted here. Saving a change to an approved or scheduled broadcast takes it back from Resend
 * (core returns the email.cancel effect) and it needs approval again.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await writeSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Broadcast not found." });
  const body = await readBody(req);
  const patch: Record<string, unknown> = {};
  for (const k of FIELDS) if (k in body) patch[k] = body[k];

  if ("schedule" in body) {
    const sch = body.schedule as { day?: unknown; time?: unknown } | null;
    if (sch === null) patch.scheduledAt = null;
    else {
      const day = typeof sch?.day === "string" ? sch.day : "";
      const time = typeof sch?.time === "string" ? sch.time : "";
      if (!DAY.test(day) || !TIME.test(time)) return json(400, { error: "Pick a day and a time for the send." });
      const ws = await getWorkspace(getDb(), auth.s.workspaceId);
      const tz = ws?.timezone ?? "America/New_York";
      const at = zonedTime(day, time, tz);
      if (localDay(at, tz) !== day) return json(400, { error: "That time doesn't exist on that day because the clocks change. Pick another time." });
      patch.scheduledAt = at.toISOString();
    }
  }

  const r = await saveBroadcast(getDb(), auth.s.workspaceId, id, patch, auth.s.userId);
  return answer(r, (x) => ({ view: x.view }));
}
