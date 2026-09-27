import { formatUsd } from "@mkt/core/cost";
import { BROADCAST_PRICE_MICROS, createBroadcastDraft, listBroadcasts } from "@mkt/core/email";
import { checkMonthLeft } from "@mkt/core/engine";
import { activeLaunchPlan } from "@mkt/core/launch";
import { enqueue } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { json } from "@/lib/session";
import { productFor, readBody, readSession, writeSession } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The product's broadcasts, newest first. */
export async function GET(req: Request) {
  const auth = await readSession(req);
  if (!auth.ok) return auth.res;
  const product = await productFor(auth.s.workspaceId, new URL(req.url).searchParams.get("slug"));
  if (!product) return json(404, { error: "Product not found." });
  return json(200, { broadcasts: await listBroadcasts(getDb(), auth.s.workspaceId, product.id) });
}

/** "Write the seasonal email · ~$0.06" (§5.4 Email): a draft row + the paid email.draft job. */
export async function POST(req: Request) {
  const auth = await writeSession(req);
  if (!auth.ok) return auth.res;
  const { s } = auth;
  const body = await readBody(req);
  const db = getDb();
  const product = await productFor(s.workspaceId, body.slug);
  if (!product) return json(404, { error: "Product not found." });
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });
  const budget = await checkMonthLeft(db, s.workspaceId, ws.monthlyLimitMicros, BROADCAST_PRICE_MICROS);
  if (!budget.ok) {
    return json(402, {
      error: `This needs about ${formatUsd(BROADCAST_PRICE_MICROS)} and you have ${formatUsd(budget.leftMicros)} left this month. Raise your limit to carry on.`,
      code: "over_limit",
    });
  }
  const plan = await activeLaunchPlan(db, s.workspaceId, product.id);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "Seasonal email";
  const r = await createBroadcastDraft(db, s.workspaceId, { productId: product.id, launchPlanId: plan?.id ?? null, name, userId: s.userId });
  if (!r.ok) return json(409, { error: r.reason });
  // BullMQ job ids may not carry a lone ':' (web preamble), so not r.job.jobId ("run:<id>").
  await enqueue<"generate", "email.draft">(getQueue("generate"), "email.draft", r.job.data, { jobId: `bc-${r.broadcastId}-${uuidv7()}` });
  return json(201, { broadcastId: r.broadcastId, runId: r.runId, estimateMicros: r.estimateMicros });
}
