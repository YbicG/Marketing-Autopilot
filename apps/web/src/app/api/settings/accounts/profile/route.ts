import { z } from "zod";
import { listProducts } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { uploadPostError, uploadPostFor } from "../upload-post";

export const dynamic = "force-dynamic";

const Body = z.object({ productId: z.uuid() });

/** Wizard step 2: one Upload-Post profile per project, named after its slug. Safe to repeat. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Pick a project first." });
  const product = (await listProducts(getDb(), s.workspaceId)).find((p) => p.id === parsed.data.productId);
  if (!product) return json(404, { error: "That project doesn't exist any more. Refresh the page." });

  const { adapter, ctx } = uploadPostFor(s.workspaceId);
  try {
    const { profileRef } = await adapter.ensureProfile(ctx, product.slug);
    return json(200, { profileRef });
  } catch (err) {
    return json(502, { error: uploadPostError(err) });
  }
}
