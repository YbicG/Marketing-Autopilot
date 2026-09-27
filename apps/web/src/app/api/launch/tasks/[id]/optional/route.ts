import { toggleOptionalTask } from "@mkt/core/launch";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { launchError, launchSession, readBody, UUID } from "../../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Switch an optional venue (BetaList, Uneed, Product Hunt, ads kit) on or off. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await launchSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Task not found." });
  const body = await readBody(req);
  if (typeof body.on !== "boolean") return json(400, { error: "Refresh the page and try again." });
  try {
    const status = await toggleOptionalTask(getDb(), auth.s.workspaceId, id, body.on, auth.s.userId);
    return json(200, { status });
  } catch (err) {
    return launchError(err);
  }
}
