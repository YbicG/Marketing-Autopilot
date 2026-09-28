import { z } from "zod";
import { confirmToolCall } from "@mkt/core/tools";
import { toolDeps } from "@/lib/agent-tools";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ tool: z.string().min(1).max(60), pat: z.uuid(), input: z.string().min(1).max(4_096) });

/**
 * The confirm page's button (D10, §9 spend phase 2): a person in the app confirms an agent's spend
 * over its limits. The price is worked out again from the input; the code lasts 10 minutes, is
 * good once, and only for that tool, token, input and price.
 */
export async function POST(req: Request) {
  const g = await requireUiSession(req);
  if (!g.ok) return g.res;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "This link is damaged. Ask the agent to try again." });
  const r = await confirmToolCall(getDb(), g.ui, parsed.data, toolDeps());
  if (!r.ok) return json(409, { error: r.message });
  return Response.json(r, { headers: { "cache-control": "no-store" } });
}
