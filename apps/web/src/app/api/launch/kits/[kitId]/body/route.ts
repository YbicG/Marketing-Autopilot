import { saveKitBody } from "@mkt/core/launch";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { kitErrorResponse, readBody, UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Save an edited kit: parsed with its kind's schema, links cleaned and every check run again. */
export async function POST(req: Request, ctx: { params: Promise<{ kitId: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { kitId } = await ctx.params;
  if (!UUID.test(kitId)) return json(404, { error: "Kit not found." });
  const body = await readBody(req);
  if (!body.body || typeof body.body !== "object") return json(400, { error: "Nothing to save." });
  try {
    const saved = await saveKitBody(getDb(), s.workspaceId, kitId, body.body, s.userId);
    if (!saved) return json(404, { error: "Kit not found." });
    return json(200, { status: saved.status, issues: saved.issues, disclosuresOk: saved.disclosuresOk });
  } catch (err) {
    return kitErrorResponse(err);
  }
}
