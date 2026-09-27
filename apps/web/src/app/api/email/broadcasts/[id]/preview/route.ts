import { previewBroadcast } from "@mkt/core/email";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { readBody, UUID, writeSession } from "../../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Live preview of unsaved text: rendered HTML + checks, nothing written. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await writeSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Broadcast not found." });
  const b = await readBody(req);
  const r = await previewBroadcast(getDb(), auth.s.workspaceId, id, { subject: b.subject, preheader: b.preheader, body: b.body });
  if (!r.ok) return json(400, { error: r.reason });
  return json(200, r.preview);
}
