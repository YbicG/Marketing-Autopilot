import { z } from "zod";
import { resumePackageRun } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { enqueue } from "@mkt/core/queue";
import { getRun } from "@mkt/core/runs";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ runId: z.string().uuid() });

/**
 * "Carry on" on the board: a package or refill run paused by the spending limit goes back to
 * running (after the limit was raised), or a run still queued gets its orchestrate pass again.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json(400, { error: "Refresh the page and try again." });
  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Product not found." });
  const run = await getRun(db, s.workspaceId, parsed.data.runId);
  if (!run || run.productId !== product.id || (run.kind !== "package" && run.kind !== "refill")) return json(404, { error: "That run wasn't found." });

  if (run.status === "paused_budget") {
    const ok = await resumePackageRun(db, s.workspaceId, run.id);
    if (!ok) return json(409, { error: "It already carried on." });
  } else if (run.status !== "queued" && run.status !== "running") {
    return json(409, { error: "This one has already finished." });
  }
  await enqueue<"generate", "package.orchestrate">(getQueue("generate"), "package.orchestrate", { runId: run.id }, {
    jobId: `orch-${run.id}-${uuidv7()}`,
    dedupe: `orch:${run.id}`,
  });
  return json(200, { runId: run.id });
}
