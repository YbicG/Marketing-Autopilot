import { approveFinishedVideos } from "@mkt/core/publishing";
import { productBySlug } from "@mkt/core/ingest";
import { errorResponse, graceMin, readBody } from "@/app/api/posts/_shared";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Approve finished videos" (D16 gate 2): every pending post of every final_ready video. */
export async function POST(req: Request) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const body = await readBody(req);
  const db = getDb();
  const product = typeof body.productSlug === "string" ? await productBySlug(db, auth.s.workspaceId, body.productSlug) : null;
  if (!product) return json(404, { error: "Project not found." });
  try {
    const r = await approveFinishedVideos(db, auth.ui, { productId: product.id, graceMin: graceMin() });
    await applyEffects(r.effects);
    return json(200, { approved: r.approved.length, skipped: r.skipped });
  } catch (err) {
    return errorResponse(err);
  }
}
