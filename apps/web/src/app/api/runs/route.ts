import { z } from "zod";
import { enqueueIngest } from "@mkt/core/queue";
import { createSummaryRun } from "@mkt/core/runs";
import { assertPublicUrl, BlockedUrl } from "@mkt/core/security";
import { getWorkspace } from "@mkt/core/tenancy";
import { env } from "@mkt/core/config";
import { getDb } from "@/lib/db";
import { getIngestQueue } from "@/lib/redis";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { startIngest } from "@/lib/start-ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** M0 summary run: `{ url }` (kept for back-compat). */
const SummaryBody = z.object({ url: z.string().min(1).max(2_000) });
/** M1 drop zone: `{ kind: "ingest", links, notes, folderUploadId }`. */
const IngestBody = z.object({
  kind: z.literal("ingest"),
  links: z.array(z.string().trim().min(1).max(2_000)).max(5).default([]),
  notes: z.string().max(20_000).nullable().default(null),
  folderUploadId: z.string().uuid().nullable().default(null),
});

/** Start a run: SSRF pre-check here too, so a bad link fails before anything is queued. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });

  const raw: unknown = await req.json().catch(() => null);
  const db = getDb();

  if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "ingest") {
    const parsed = IngestBody.safeParse(raw);
    if (!parsed.success) return json(400, { error: "Add up to 5 links, a project folder or a few notes." });
    const ws = await getWorkspace(db, s.workspaceId);
    if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });
    const { links, notes, folderUploadId } = parsed.data;
    const out = await startIngest(db, s.workspaceId, { links, notes: notes?.trim() || null, folderUploadId });
    if (!out.ok) return json(400, { error: out.error });
    return json(201, { runId: out.runId, slug: out.slug });
  }

  const parsed = SummaryBody.safeParse(raw);
  if (!parsed.success) return json(400, { error: "Paste a link to your product." });

  const trimmed = parsed.data.url.trim();
  const target = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    ({ url } = await assertPublicUrl(target, { selfIps: env().SELF_IPS }));
  } catch (err) {
    if (err instanceof BlockedUrl) return json(400, { error: err.message });
    throw err;
  }

  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });

  const runId = await createSummaryRun(db, s.workspaceId, url.toString());
  await enqueueIngest(getIngestQueue(), "m0.summary", { runId }, runId);
  return json(201, { runId });
}
