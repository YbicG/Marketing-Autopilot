import { setTaskStatus } from "@mkt/core/launch";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { launchError, launchSession, readBody, UUID } from "../../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Status = "done" | "skipped" | "todo";
const STATUSES: ReadonlySet<string> = new Set<Status>(["done", "skipped", "todo"]);

/** Mark done / Skip / Undo on a checklist row. Gates refuse every hand change (setTaskStatus). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await launchSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Task not found." });
  const body = await readBody(req);
  if (typeof body.status !== "string" || !STATUSES.has(body.status)) return json(400, { error: "Refresh the page and try again." });
  try {
    const now = await setTaskStatus(getDb(), auth.s.workspaceId, id, body.status as Status, auth.s.userId);
    return json(200, { status: now });
  } catch (err) {
    return launchError(err);
  }
}
