import { z } from "zod";
import { CarouselTemplate, SocialPlatform } from "@mkt/contracts";
import { saveCarousel, syncDraftStates } from "@mkt/core/engine";
import { onVariantChanged, voidApproval, type VoidResult } from "@mkt/core/publishing";
import { enqueue } from "@mkt/core/queue";
import { uuidv7 } from "@mkt/db";
import { getDb } from "@/lib/db";
import { applyEffects, getQueue } from "@/lib/queues";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = z.string().uuid();
const Slide = z.object({
  template: CarouselTemplate,
  headline: z.string().max(300),
  body: z.string().max(1_000).nullable(),
  assetId: UUID.nullable(),
});
const Caption = z.object({ text: z.string().max(5_000), hashtags: z.array(z.string().max(100)).max(30) });
const Body = z.object({
  slides: z.array(Slide).min(1).max(20),
  captions: z.partialRecord(SocialPlatform, Caption).optional(),
  altText: z.string().max(2_000).nullable().optional(),
});

/**
 * Swipe post editor save (§2.3, §5.5): the slides are shared by every platform of the item (any of
 * its variant ids works here). Approvals are voided (the images will change), then render.still is
 * queued for each variant that passes its checks.
 */
export async function POST(req: Request, ctx: { params: Promise<{ variantId: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { variantId } = await ctx.params;
  if (!UUID.safeParse(variantId).success) return json(404, { error: "That swipe post wasn't found." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Some slide text is too long to save. Shorten it and try again." });

  const db = getDb();
  const v = await db.query.variants.findFirst({ where: (t, { and, eq }) => and(eq(t.id, variantId), eq(t.workspaceId, s.workspaceId)) });
  if (!v) return json(404, { error: "That swipe post wasn't found." });
  const r = await saveCarousel(db, s.workspaceId, v.contentItemId, parsed.data);
  if (!r.ok) return json(r.status, { error: r.message });

  const actor = { type: "user" as const, id: s.userId };
  const effects: VoidResult[] = [];
  for (const id of r.variantIds) {
    effects.push(...(await onVariantChanged(db, s.workspaceId, id, actor)));
    // The approval hash covers the caption text only through the rendered files; void explicitly.
    const ps = await db.query.posts.findMany({ where: (t, { and, eq }) => and(eq(t.variantId, id), eq(t.workspaceId, s.workspaceId)), columns: { id: true } });
    for (const p of ps) {
      const res = await voidApproval(db, s.workspaceId, p.id, "The swipe post was edited.", actor);
      if (res?.effects.length) effects.push(res);
    }
  }
  await applyEffects(effects);
  for (const id of r.variantIds) await syncDraftStates(db, s.workspaceId, id);
  const render = getQueue("render");
  for (const id of r.renderVariantIds) {
    await enqueue<"render", "render.still">(render, "render.still", { contentItemId: r.contentItemId, variantId: id }, { jobId: `still-${id}-${uuidv7()}` });
  }
  return json(200, { issues: r.issues, rendering: r.renderVariantIds.length });
}
