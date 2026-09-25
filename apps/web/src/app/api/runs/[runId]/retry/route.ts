import { getRun } from "@mkt/core/runs";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { startIngest } from "@/lib/start-ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Try again" on a failed ingest run: a new run from the same links, notes and folder. */
export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { runId } = await ctx.params;
  const db = getDb();
  const run = await getRun(db, s.workspaceId, runId);
  if (!run) return json(404, { error: "Run not found." });
  if (run.kind !== "ingest") return json(400, { error: "Only product reads can be retried here." });
  if (run.status !== "failed") return json(409, { error: "This run hasn't failed." });

  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });

  const { links, notes, folderUploadId } = run.input as { links?: unknown; notes?: unknown; folderUploadId?: unknown };
  const out = await startIngest(db, s.workspaceId, {
    links: Array.isArray(links) ? links : [],
    notes: typeof notes === "string" ? notes : null,
    folderUploadId: typeof folderUploadId === "string" ? folderUploadId : null,
  });
  if (!out.ok) return json(400, { error: out.error });
  return json(201, { runId: out.runId, slug: out.slug });
}
