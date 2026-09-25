import { env } from "@mkt/core/config";
import { storage } from "@mkt/core/media";
import { getDb } from "@/lib/db";
import { json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;

/**
 * Serves one asset by id, scoped to the caller's workspace. `?v=preview` serves the small JPEG
 * preview when there is one. Never serves by raw storage key.
 */
export async function GET(req: Request, ctx: { params: Promise<{ assetId: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { assetId } = await ctx.params;
  if (!UUID.test(assetId)) return json(404, { error: "Not found." });

  const asset = await getDb().query.assets.findFirst({
    where: (a, { and, eq }) => and(eq(a.id, assetId), eq(a.workspaceId, s.workspaceId)),
  });
  if (!asset) return json(404, { error: "Not found." });

  const wantPreview = new URL(req.url).searchParams.get("v") === "preview";
  const previewKey = typeof asset.origination.previewKey === "string" ? asset.origination.previewKey : null;
  const key = wantPreview && previewKey ? previewKey : asset.storageKey;
  const mime = wantPreview && previewKey ? "image/jpeg" : IMAGE_MIME.test(asset.mime) ? asset.mime : "application/octet-stream";

  let body: Buffer;
  try {
    body = await storage(env()).get(key);
  } catch {
    return json(404, { error: "Not found." });
  }
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": mime,
      "content-length": String(body.byteLength),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
