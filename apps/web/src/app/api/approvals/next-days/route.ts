import { approveNextDays } from "@mkt/core/publishing";
import { productBySlug } from "@mkt/core/ingest";
import { errorResponse, graceMin, readBody } from "@/app/api/posts/_shared";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Approve next 7 days (N posts)" on the Queue screen (D9: UI session only). */
export async function POST(req: Request) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const body = await readBody(req);
  const days = body.days === undefined ? 7 : Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 31) return json(400, { error: "Pick between 1 and 31 days." });
  const db = getDb();
  const product = typeof body.productSlug === "string" ? await productBySlug(db, auth.s.workspaceId, body.productSlug) : null;
  if (!product) return json(404, { error: "Project not found." });
  try {
    const r = await approveNextDays(db, auth.ui, { days, productId: product.id, graceMin: graceMin() });
    await applyEffects(r.effects);
    return json(200, { approved: r.approved.length, skipped: r.skipped });
  } catch (err) {
    return errorResponse(err);
  }
}
