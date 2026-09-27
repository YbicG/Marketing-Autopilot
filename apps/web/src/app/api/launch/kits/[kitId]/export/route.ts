import { env } from "@mkt/core/config";
import { exportKit } from "@mkt/core/launch";
import { storage } from "@mkt/core/media";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { kitErrorResponse, UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Download kit" (§8: the kit won't export without its disclosures). Builds the zip, keeps it as an
 * asset and returns where to download it (/api/media serves application/zip as a download).
 */
export async function POST(req: Request, ctx: { params: Promise<{ kitId: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { kitId } = await ctx.params;
  if (!UUID.test(kitId)) return json(404, { error: "Kit not found." });
  try {
    const out = await exportKit({ db: getDb(), storage: storage(env()) }, s.workspaceId, kitId);
    return json(200, { assetId: out.assetId, fileName: out.fileName, files: out.files, href: `/api/media/${out.assetId}?dl=1` });
  } catch (err) {
    return kitErrorResponse(err);
  }
}
