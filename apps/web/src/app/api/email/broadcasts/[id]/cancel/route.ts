import { cancelBroadcast } from "@mkt/core/email";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { answer, UUID, userActor, writeSession } from "../../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Drop the broadcast for good (canceled at Resend when it's scheduled there). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await writeSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Broadcast not found." });
  return answer(await cancelBroadcast(getDb(), auth.s.workspaceId, id, userActor(auth.s.userId), { reason: "Canceled in the editor" }));
}
