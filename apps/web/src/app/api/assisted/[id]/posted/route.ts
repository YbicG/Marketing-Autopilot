import { markAssistedPosted } from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { errorResponse, readBody, UUID } from "@/app/api/posts/_shared";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Mark as posted" on a Copy & open card, with the link to the live post. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Task not found." });
  const body = await readBody(req);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return json(400, { error: "Paste the link to the live post." });
  const db = getDb();
  const ws = await getWorkspace(db, auth.s.workspaceId);
  try {
    await markAssistedPosted(db, auth.s.workspaceId, id, url, { userId: auth.s.userId, tz: ws?.timezone ?? "UTC" });
    return json(200, { ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
