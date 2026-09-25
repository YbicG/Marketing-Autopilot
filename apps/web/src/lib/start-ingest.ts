import { IntakeInput } from "@mkt/contracts";
import { env } from "@mkt/core/config";
import { classifyInput, createIngestRun, InvalidUpload } from "@mkt/core/ingest";
import { enqueueIngest } from "@mkt/core/queue";
import { assertPublicUrl, BlockedUrl } from "@mkt/core/security";
import type { Db } from "@mkt/db";
import { getIngestQueue } from "./redis";

export type StartResult = { ok: true; runId: string; slug: string } | { ok: false; error: string };

/**
 * Drop zone and "Try again" both land here: SSRF pre-check every website link (so a private IP is
 * refused before anything is created), then create the run and queue it with jobId = runId.
 */
export async function startIngest(db: Db, workspaceId: string, raw: unknown): Promise<StartResult> {
  const parsed = IntakeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Add up to 5 links, a project folder or a few notes." };
  const input = parsed.data;

  for (const link of input.links) {
    const c = classifyInput(link);
    if (c.kind !== "website") continue;
    try {
      await assertPublicUrl(c.url, { selfIps: env().SELF_IPS });
    } catch (err) {
      if (err instanceof BlockedUrl) return { ok: false, error: err.message };
      throw err;
    }
  }

  let created: Awaited<ReturnType<typeof createIngestRun>>;
  try {
    created = await createIngestRun(db, workspaceId, input);
  } catch (err) {
    if (err instanceof InvalidUpload) return { ok: false, error: err.message };
    if (err instanceof Error && err.name === "ZodError") {
      return { ok: false, error: "Add up to 5 links, a project folder or a few notes." };
    }
    throw err;
  }
  await enqueueIngest(getIngestQueue(), "ingest.run", { runId: created.runId }, created.runId);
  return { ok: true, runId: created.runId, slug: created.slug };
}
