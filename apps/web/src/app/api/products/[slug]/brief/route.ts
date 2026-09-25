import { briefMarkdown, planView, productBySlug, publicClaimsFor } from "@mkt/core/ingest";
import { getDb } from "@/lib/db";
import { json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Export brief": the profile, angles and messaging as a markdown download (public facts only). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Product not found." });
  const view = await planView(db, product);
  if (!view.dna) return json(409, { error: "There's no profile yet. Read your product first." });

  const claims = await publicClaimsFor(db, view.dna.id);
  const md = briefMarkdown({
    productName: product.name,
    dna: view.dna.dna,
    strategy: view.strategy?.output ?? null,
    launchDate: view.strategy?.launchDate ?? null,
    publicClaims: claims.map((c) => ({ ref: c.ref, text: c.text })),
  });
  const filename = `${product.slug.replace(/[^a-z0-9-]/gi, "") || "product"}-brief.md`;
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
