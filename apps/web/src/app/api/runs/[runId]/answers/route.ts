import { z } from "zod";
import { answerGapQuestion } from "@mkt/core/ingest";
import { getRun } from "@mkt/core/runs";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  questionId: z.string().uuid(),
  /** null = Skip. */
  answer: z.string().max(2_000).nullable(),
});

/** Answer or skip one in-feed question. The run never waits long for these. */
export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { runId } = await ctx.params;
  const db = getDb();
  if (!(await getRun(db, s.workspaceId, runId))) return json(404, { error: "Run not found." });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Type an answer, pick one, or skip." });
  const ok = await answerGapQuestion(db, s.workspaceId, parsed.data.questionId, parsed.data.answer);
  if (!ok) return json(404, { error: "That question wasn't found." });
  return json(200, { ok: true });
}
