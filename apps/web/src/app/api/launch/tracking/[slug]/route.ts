import { checkTrackingTest, firstPartyAggregateFor, startTrackingTest } from "@mkt/core/launch";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { launchError, launchSession, productFor, readBody } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The tracking test gate: "start" makes the test link (opened logged out, in a private window or on
 * a phone), "check" asks the site's own numbers whether that visit arrived. launch.tick re-checks
 * hourly too. Nothing here can pass the gate by hand.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await launchSession(req);
  if (!auth.ok) return auth.res;
  const { slug } = await ctx.params;
  const product = await productFor(auth.s.workspaceId, slug);
  if (!product) return json(404, { error: "Project not found." });
  const body = await readBody(req);
  const db = getDb();
  try {
    if (body.action === "start") return json(200, await startTrackingTest(db, auth.s.workspaceId, product.id));
    if (body.action === "check") {
      return json(200, await checkTrackingTest({ db, aggregateFor: firstPartyAggregateFor(db) }, auth.s.workspaceId, product.id));
    }
    return json(400, { error: "Refresh the page and try again." });
  } catch (err) {
    return launchError(err);
  }
}
