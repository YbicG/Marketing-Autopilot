import { postDetail } from "@mkt/core/publishing";
import { getDb } from "@/lib/db";
import { json, sessionFromRequest } from "@/lib/session";
import { UUID } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The Queue post drawer: text, files, account, options, cap problems. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Post not found." });
  const d = await postDetail(getDb(), s.workspaceId, id);
  if (!d) return json(404, { error: "Post not found." });
  return json(200, { ...d, scheduledAt: d.scheduledAt.toISOString(), approvedAt: d.approvedAt?.toISOString() ?? null });
}
