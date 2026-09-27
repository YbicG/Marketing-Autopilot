import { voidBroadcast } from "@mkt/core/email";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { answer, UUID, userActor, writeSession } from "../../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Take back": the approval is voided and a broadcast Resend holds is canceled there. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await writeSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Broadcast not found." });
  return answer(await voidBroadcast(getDb(), auth.s.workspaceId, id, "Taken back in the editor", userActor(auth.s.userId)));
}
