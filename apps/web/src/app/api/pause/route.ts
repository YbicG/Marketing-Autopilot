import { productBySlug } from "@mkt/core/ingest";
import { pausePosting, resumePosting } from "@mkt/core/publishing";
import { errorResponse, publishDeps, readBody, userActor } from "@/app/api/posts/_shared";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Pause all posting" (§5.8 step 5) for one project or everything, and Resume. Pausing removes the
 * delayed jobs; resuming re-adds them (slots already past the grace window become missed). Resume
 * lets posts go out again, so both need the UI session (D9). pausePosting/resumePosting run their
 * own queue effects through publishEffects().
 */
export async function POST(req: Request) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const body = await readBody(req);
  if (body.action !== "pause" && body.action !== "resume") return json(400, { error: "Say pause or resume." });
  if (typeof body.scope !== "string" || !body.scope) return json(400, { error: "Pick a project or everything." });
  const db = getDb();
  let productId: string | undefined;
  if (body.scope !== "all") {
    const product = await productBySlug(db, auth.s.workspaceId, body.scope);
    if (!product) return json(404, { error: "Project not found." });
    productId = product.id;
  }
  const scope = { workspaceId: auth.s.workspaceId, ...(productId ? { productId } : {}) };
  try {
    if (body.action === "pause") {
      const r = await pausePosting(publishDeps(), scope, userActor(auth.s.userId));
      return json(200, r);
    }
    const r = await resumePosting(publishDeps(), scope, userActor(auth.s.userId));
    return json(200, r);
  } catch (err) {
    return errorResponse(err);
  }
}
