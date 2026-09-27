import { formatUsd, loadRateCards, rateLookup } from "@mkt/core/cost";
import { checkMonthLeft } from "@mkt/core/engine";
import { createLandingAudit, estimateLandingAuditMicros, latestLandingAudit } from "@mkt/core/launch";
import { enqueue } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { json, sessionFromRequest } from "@/lib/session";
import { launchError, launchSession, productFor, readBody } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A landing check still going for this long is treated as stuck, so a new one can start. */
const STUCK_MS = 15 * 60_000;

/** The newest landing audit (the gates panel polls this while one is queued or running). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Sign in again." });
  const { slug } = await ctx.params;
  const product = await productFor(s.workspaceId, slug);
  if (!product) return json(404, { error: "Project not found." });
  return json(200, { audit: await latestLandingAudit(getDb(), s.workspaceId, product.id) });
}

/**
 * "Run landing check": queue an audit row and the launch.landing_audit render job (§5.4). The
 * capture is free; at most one small look at the phone screenshot is paid, so it's priced first (§7.3).
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await launchSession(req);
  if (!auth.ok) return auth.res;
  const { slug } = await ctx.params;
  const product = await productFor(auth.s.workspaceId, slug);
  if (!product) return json(404, { error: "Project not found." });
  const body = await readBody(req);
  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : undefined;
  const db = getDb();
  try {
    const ws = await getWorkspace(db, auth.s.workspaceId);
    if (!ws) return json(401, { error: "Sign in again." });
    const current = await latestLandingAudit(db, auth.s.workspaceId, product.id);
    if (current && (current.status === "queued" || current.status === "running") && Date.now() - Date.parse(current.createdAt) < STUCK_MS) {
      return json(409, { error: "A landing check is already running. Give it a minute." });
    }
    const estimate = estimateLandingAuditMicros(rateLookup(await loadRateCards(db)));
    const budget = await checkMonthLeft(db, auth.s.workspaceId, ws.monthlyLimitMicros, estimate);
    if (!budget.ok) {
      return json(402, {
        error: `This can cost up to ${formatUsd(estimate)} and you have ${formatUsd(budget.leftMicros)} left this month. Raise your limit to carry on.`,
        code: "over_limit",
      });
    }
    const r = await createLandingAudit(db, auth.s.workspaceId, product.id, url);
    await enqueue<"render", "launch.landing_audit">(getQueue("render"), "launch.landing_audit", { auditId: r.auditId }, { jobId: r.jobId });
    return json(202, r);
  } catch (err) {
    return launchError(err);
  }
}
