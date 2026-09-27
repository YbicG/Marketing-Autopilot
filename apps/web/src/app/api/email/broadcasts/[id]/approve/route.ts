import { approveBroadcast } from "@mkt/core/email";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";
import { answer, UUID } from "../../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** D9: "Approve & schedule". Only a signed-in person in the web UI (cookie + Origin + CSRF header). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Broadcast not found." });
  const r = await approveBroadcast(getDb(), auth.ui, id);
  return answer(r, (x) => ({ approvalId: x.approvalId }));
}
