import { setTrustedOrigin } from "@mkt/core/capture";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { captureAuth, captureError, readJson } from "../../_lib/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The demo site's internal address and the pages the recorder must never open (D26, UI only). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const auth = await captureAuth(req, slug, { ui: true });
  if (!auth.ok) return auth.res;
  const body = await readJson(req);
  const origin = typeof body.origin === "string" ? body.origin : null;
  const denylist = Array.isArray(body.denylist) ? body.denylist.filter((x): x is string => typeof x === "string") : [];
  try {
    const out = await setTrustedOrigin(getDb(), auth.s.workspaceId, auth.product.id, origin, denylist);
    return json(200, out);
  } catch (err) {
    return captureError(err);
  }
}
