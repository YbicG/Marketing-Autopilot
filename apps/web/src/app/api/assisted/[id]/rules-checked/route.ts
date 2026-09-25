import { markRulesChecked } from "@mkt/core/publishing";
import { errorResponse, UUID } from "@/app/api/posts/_shared";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "I checked the rules today" on a Copy & open card. Only a person in the web UI can tick it. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Task not found." });
  try {
    await markRulesChecked(getDb(), auth.s.workspaceId, id, auth.s.userId);
    return json(200, { ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
