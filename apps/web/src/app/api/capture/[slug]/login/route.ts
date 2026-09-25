import { saveDemoLogin } from "@mkt/core/capture";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { captureAuth, captureError, readJson } from "../../_lib/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The demo site's test login, stored in the vault (capture.login.<productId>). Write-only: it is
 * never sent back to the page, which only shows that one is saved.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const auth = await captureAuth(req, slug, { ui: true });
  if (!auth.ok) return auth.res;
  const body = await readJson(req);
  try {
    await saveDemoLogin(getDb(), auth.s.workspaceId, auth.product.id, { username: body.username, password: body.password, loginPath: body.loginPath });
    return json(200, { saved: true });
  } catch (err) {
    if (err instanceof Error && err.name === "VaultKeyError") {
      console.error("[capture login]", err);
      return json(500, { error: "The key store isn't set up on the server yet, so the login can't be saved." });
    }
    return captureError(err);
  }
}
