import { z } from "zod";
import { updateConnectionLimits } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z
  .object({ id: z.uuid(), maxPerDay: z.number().int().min(1).max(3).optional(), shared: z.boolean().optional() })
  .refine((b) => b.maxPerDay !== undefined || b.shared !== undefined);

/** Per-account posts per day (1–3) and whether the account is shared across projects. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Pick 1, 2 or 3 posts a day." });
  const { id, ...patch } = parsed.data;
  const ok = await updateConnectionLimits(getDb(), s.workspaceId, id, patch);
  if (!ok) return json(404, { error: "That account isn't connected any more. Refresh the page." });
  return json(200, { ok: true });
}
