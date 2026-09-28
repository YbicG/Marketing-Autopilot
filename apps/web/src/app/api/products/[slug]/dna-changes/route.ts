import { z } from "zod";
import { productBySlug } from "@mkt/core/ingest";
import { acceptDnaChange, rejectDnaChange } from "@mkt/core/tools";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["accept", "reject"]), id: z.uuid() });

/** Plan screen → Accept / Reject a profile change an agent suggested. A person in the app only (D9). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const g = await requireUiSession(req);
  if (!g.ok) return g.res;
  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, g.s.workspaceId, slug);
  if (!product) return json(404, { error: "Product not found." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "That didn't look right. Refresh the page and try again." });
  const r = parsed.data.action === "accept" ? await acceptDnaChange(db, g.ui, parsed.data.id) : await rejectDnaChange(db, g.ui, parsed.data.id);
  return r.ok ? json(200, { ok: true }) : json(409, { error: r.message });
}
