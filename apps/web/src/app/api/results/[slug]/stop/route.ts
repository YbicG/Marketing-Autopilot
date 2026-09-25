import { setAngleStatus } from "@mkt/core/analytics";
import { productBySlug } from "@mkt/core/ingest";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Stop this angle" (and "Start it again" with `{ status: "active" }`). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const body = (await req.json().catch(() => ({}))) as { angleId?: unknown; status?: unknown };
  const angleId = typeof body.angleId === "string" && UUID.test(body.angleId) ? body.angleId : null;
  if (!angleId) return json(400, { error: "Pick an angle first." });
  const status = body.status === "active" ? "active" : "stopped";

  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Project not found." });
  const ok = await setAngleStatus(db, s.workspaceId, product.id, angleId, status);
  if (!ok) return json(404, { error: "That angle isn't there any more. Refresh the page." });
  return json(200, { angleId, status });
}
