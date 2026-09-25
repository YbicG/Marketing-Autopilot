import { z } from "zod";
import { REWRITE_PRICE_MICROS, checkMonthLeft, createRewriteRun } from "@mkt/core/engine";
import { enqueue } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = z.string().uuid();
const Body = z.object({ ask: z.string().trim().max(500).optional() });

/** "Rewrite for this platform · ~$0.005" (§2.3 Post editor): a copy.rewrite job on the generate queue. */
export async function POST(req: Request, ctx: { params: Promise<{ variantId: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { variantId } = await ctx.params;
  if (!UUID.safeParse(variantId).success) return json(404, { error: "That post wasn't found." });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json(400, { error: "Keep the note under 500 characters." });

  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });
  const budget = await checkMonthLeft(db, s.workspaceId, ws.monthlyLimitMicros, REWRITE_PRICE_MICROS);
  if (!budget.ok) return json(402, { error: "You've reached your monthly spending limit. Raise it to rewrite.", code: "over_limit" });

  const runId = await createRewriteRun(db, s.workspaceId, variantId, parsed.data.ask || undefined);
  if (!runId) return json(404, { error: "That post wasn't found." });
  await enqueue<"generate", "copy.rewrite">(getQueue("generate"), "copy.rewrite", { runId, variantId }, { jobId: `rewrite-${runId}` });
  return json(201, { runId });
}
