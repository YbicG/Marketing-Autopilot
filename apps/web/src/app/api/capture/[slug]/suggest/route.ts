import { suggestFlows } from "@mkt/core/capture";
import { loadRateCards, rateLookup } from "@mkt/core/cost";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { captureAuth, captureError } from "../../_lib/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Suggest flows · ~$0.02" (capture.flow_plan, Sonnet). Saved unconfirmed; nothing is recorded. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const auth = await captureAuth(req, slug);
  if (!auth.ok) return auth.res;
  const db = getDb();
  try {
    const out = await suggestFlows({ db, rates: rateLookup(await loadRateCards(db)) }, { workspaceId: auth.s.workspaceId, productId: auth.product.id });
    return json(201, { flowIds: out.flowIds, dropped: out.dropped.length, spentMicros: out.spentMicros });
  } catch (err) {
    return captureError(err);
  }
}
