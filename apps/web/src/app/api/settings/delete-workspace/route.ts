import { z } from "zod";
import { deleteWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({ confirm: z.literal("delete") });

/** Deletes every row the workspace owns and signs the user out everywhere. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: 'Type "delete" to confirm.' });
  await deleteWorkspace(getDb(), s.workspaceId, s.userId);
  return json(200, { ok: true });
}
