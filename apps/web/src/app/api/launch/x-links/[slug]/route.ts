import { setXLinksWindow } from "@mkt/core/publishing";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";
import { productFor, readBody } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "X links in launch week" (D24): the dates the Upload-Post X links add-on is on. Inside them X
 * posts carry their tracking link, so this lets links publish: UiSession only (D9).
 * Body: { from, until } to save, or { off: true } to turn it off.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await requireUiSession(req);
  if (!auth.ok) return auth.res;
  const { slug } = await ctx.params;
  const product = await productFor(auth.s.workspaceId, slug);
  if (!product) return json(404, { error: "Project not found." });
  const body = await readBody(req);
  let window: { from: string; until: string } | null;
  if (body.off === true) window = null;
  else if (typeof body.from === "string" && typeof body.until === "string") window = { from: body.from, until: body.until };
  else return json(400, { error: "Pick a start and an end date." });
  try {
    const r = await setXLinksWindow(getDb(), auth.s.workspaceId, product.id, window, auth.s.userId);
    if (!r.ok) return json(400, { error: r.error });
    return json(200, { window: r.window });
  } catch (err) {
    console.error("[launch x-links]", err);
    return json(500, { error: "That didn't work. Try again in a minute." });
  }
}
