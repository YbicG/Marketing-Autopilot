import { createRegenerateRun, productBySlug } from "@mkt/core/ingest";
import { enqueueIngest } from "@mkt/core/queue";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { getIngestQueue } from "@/lib/redis";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Regenerate profile": rewrite it from the same sources, keeping pinned fields. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Product not found." });
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });

  const runId = await createRegenerateRun(db, s.workspaceId, product.id);
  if (!runId) return json(409, { error: "There's no profile to rewrite yet. Read your product first." });
  await enqueueIngest(getIngestQueue(), "dna.regenerate", { runId }, runId);
  return json(201, { runId });
}
