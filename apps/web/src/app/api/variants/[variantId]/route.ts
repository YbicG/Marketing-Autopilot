import { z } from "zod";
import { saveTextVariant, syncDraftStates } from "@mkt/core/engine";
import { onVariantChanged } from "@mkt/core/publishing";
import { getDb } from "@/lib/db";
import { applyEffects } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = z.string().uuid();
const Body = z.object({
  text: z.string().max(10_000),
  parts: z.array(z.string().max(5_000)).max(25).optional(),
  hashtags: z
    .array(z.string().max(100))
    .max(30)
    .transform((a) => a.map((h) => h.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))
    .optional(),
  firstComment: z.string().max(5_000).nullable().optional(),
  altText: z.string().max(2_000).nullable().optional(),
});

/**
 * Post editor save (§2.3): new text for one platform variant. A change drops approved posts back
 * to pending_approval and removes their delayed jobs (onVariantChanged → applyEffects, D9); posts
 * with a blocking check then sit in draft.
 */
export async function POST(req: Request, ctx: { params: Promise<{ variantId: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { variantId } = await ctx.params;
  if (!UUID.safeParse(variantId).success) return json(404, { error: "That post wasn't found." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "That text is too long to save. Shorten it and try again." });

  const db = getDb();
  const r = await saveTextVariant(db, s.workspaceId, variantId, parsed.data);
  if (!r.ok) return json(r.status, { error: r.message });
  if (r.changed) await applyEffects(await onVariantChanged(db, s.workspaceId, variantId, { type: "user", id: s.userId }));
  await syncDraftStates(db, s.workspaceId, variantId);
  return json(200, { issues: r.issues, changed: r.changed });
}
