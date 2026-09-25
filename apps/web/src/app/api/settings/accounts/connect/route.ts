import { z } from "zod";
import { SocialPlatform } from "@mkt/contracts";
import { listProducts } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { uploadPostError, uploadPostFor } from "../upload-post";

export const dynamic = "force-dynamic";

const Body = z.object({ productId: z.uuid(), platforms: z.array(SocialPlatform).min(1).max(7) });

/**
 * Wizard steps 2–3: make sure the project's Upload-Post profile exists, then return a hosted
 * connect link. CJ signs in on the platform's own page (§13); we never see the login.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Pick at least one place to connect." });
  const product = (await listProducts(getDb(), s.workspaceId)).find((p) => p.id === parsed.data.productId);
  if (!product) return json(404, { error: "That project doesn't exist any more. Refresh the page." });

  const { adapter, ctx } = uploadPostFor(s.workspaceId);
  try {
    const { profileRef } = await adapter.ensureProfile(ctx, product.slug);
    const link = await adapter.connectLink(ctx, profileRef, [...new Set(parsed.data.platforms)]);
    if (!/^https:\/\//.test(link.url)) return json(502, { error: "Upload-Post sent back a link we can't open. Try again." });
    return json(200, { url: link.url, profileRef });
  } catch (err) {
    return json(502, { error: uploadPostError(err) });
  }
}
