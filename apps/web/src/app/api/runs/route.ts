import { z } from "zod";
import { enqueueIngest } from "@mkt/core/queue";
import { createSummaryRun } from "@mkt/core/runs";
import { assertPublicUrl, BlockedUrl } from "@mkt/core/security";
import { getWorkspace } from "@mkt/core/tenancy";
import { env } from "@mkt/core/config";
import { getDb } from "@/lib/db";
import { getIngestQueue } from "@/lib/redis";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({ url: z.string().min(1).max(2_000) });

/** Start a summary run: SSRF pre-check here too, so a bad link fails before anything is queued. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Paste a link to your product." });

  const raw = /^https?:\/\//i.test(parsed.data.url.trim()) ? parsed.data.url.trim() : `https://${parsed.data.url.trim()}`;
  let url: URL;
  try {
    ({ url } = await assertPublicUrl(raw, { selfIps: env().SELF_IPS }));
  } catch (err) {
    if (err instanceof BlockedUrl) return json(400, { error: err.message });
    throw err;
  }

  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws?.onboardedAt) return json(409, { error: "Set your monthly spending limit first." });

  const runId = await createSummaryRun(db, s.workspaceId, url.toString());
  await enqueueIngest(getIngestQueue(), "m0.summary", { runId }, runId);
  return json(201, { runId });
}
