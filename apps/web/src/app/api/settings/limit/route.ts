import { z } from "zod";
import { setMonthlyLimit } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({ usd: z.number().int().min(1).max(1_000) });

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Pick a whole-dollar limit between $1 and $1,000." });
  await setMonthlyLimit(getDb(), s.workspaceId, parsed.data.usd, s.userId);
  return json(200, { ok: true });
}
