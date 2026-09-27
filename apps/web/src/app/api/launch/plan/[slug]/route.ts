import { latestCampaign } from "@mkt/core/engine";
import { activeLaunchPlan, createLaunchPlan, launchTemplate, launchView, refreshLaunchPlan } from "@mkt/core/launch";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { launchError, launchSession, productFor, readBody } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Make my launch checklist" (action "create", with the optional venues switched on) and "Refresh"
 * (action "refresh": re-dates open tasks when the campaign's dates moved, then re-evaluates).
 * Both are idempotent per campaign (createLaunchPlan).
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await launchSession(req);
  if (!auth.ok) return auth.res;
  const { slug } = await ctx.params;
  const product = await productFor(auth.s.workspaceId, slug);
  if (!product) return json(404, { error: "Project not found." });
  const body = await readBody(req);
  const action = body.action === "refresh" ? "refresh" : body.action === "create" ? "create" : null;
  if (!action) return json(400, { error: "Refresh the page and try again." });

  const db = getDb();
  const ws = auth.s.workspaceId;
  try {
    const latest = await latestCampaign(db, ws, product.id);
    if (action === "create") {
      if (!latest) return json(409, { error: "Make your campaign on the Plan tab first." });
      const optional = new Set(launchTemplate().tasks.filter((t) => t.optional).map((t) => t.key));
      const raw = Array.isArray(body.optionalOn) ? body.optionalOn : [];
      const optionalOn = raw.filter((k): k is string => typeof k === "string" && optional.has(k));
      // Booking Product Hunt also switches on its launch-day row.
      if (optionalOn.includes("book.producthunt") && optional.has("launch.producthunt")) optionalOn.push("launch.producthunt");
      const r = await createLaunchPlan(db, ws, { campaignId: latest.campaign.id, optionalOn, userId: auth.s.userId });
      return json(r.created ? 201 : 200, r);
    }

    const plan = await activeLaunchPlan(db, ws, product.id);
    if (!plan) return json(409, { error: "Make your launch checklist first." });
    if (latest) {
      // Keep the optional venues that are on now (a newer campaign starts its own plan from them).
      const view = await launchView(db, ws, product.id);
      const optionalOn = (view?.groups ?? []).flatMap((g) => g.tasks).filter((t) => t.optional && t.status !== "skipped").map((t) => t.key);
      const r = await createLaunchPlan(db, ws, { campaignId: latest.campaign.id, optionalOn, userId: auth.s.userId });
      return json(200, r);
    }
    const r = await refreshLaunchPlan(db, ws, plan.id);
    return json(200, { planId: plan.id, created: false, redated: false, added: [], overdue: [], changed: r.changed });
  } catch (err) {
    return launchError(err);
  }
}
