import { postConnection } from "@mkt/core/publishing";
import { publisher, uploadPost, type Platform } from "@mkt/providers";
import { getDb } from "@/lib/db";
import { json, sessionFromRequest } from "@/lib/session";
import { providerCtx, UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** TikTok creator_info for the composer: allowed audiences, toggles the account locks, caps. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Post not found." });
  const found = await postConnection(getDb(), s.workspaceId, id);
  if (!found) return json(200, { creatorInfo: null, message: "Connect a TikTok account to see its settings." });
  const { conn } = found;
  try {
    const adapter = conn.publisher === "upload_post" ? uploadPost : publisher(conn.publisher);
    const info = await adapter.creatorInfo(providerCtx(s.workspaceId), conn.profileRef, conn.platform as Platform);
    if (!info) return json(200, { creatorInfo: null, message: null });
    const { raw: _raw, ...creatorInfo } = info;
    return json(200, { creatorInfo, handle: conn.handle, message: null });
  } catch (err) {
    const msg =
      err instanceof Error && /Settings/.test(err.message)
        ? err.message
        : "Couldn't read this TikTok account's settings. Try again in a minute.";
    return json(200, { creatorInfo: null, message: msg });
  }
}
