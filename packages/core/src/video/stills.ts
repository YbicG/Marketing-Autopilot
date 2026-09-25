import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { CarouselVariantBody } from "@mkt/contracts";
import { schema } from "@mkt/db";
import { variantContentHash } from "../engine/hash.ts";
import { brandFor } from "./context.ts";
import type { VideoDeps } from "./deps.ts";
import { computeTier, digitalSourceType, type Ingredient } from "./provenance.ts";
import type { StillPropsLike } from "./renderer.ts";
import { linkLineage, storeAsset } from "./store.ts";

const { assets, contentItems, variants, campaigns } = schema;

/** §5.5 output per platform: IG JPEG 1080×1350, TikTok photo 1080×1920, LinkedIn PDF, X ≤4 images. */
export const STILL_OUTPUT: Record<string, { width: number; height: number; maxImages: number; pdf: boolean }> = {
  instagram: { width: 1080, height: 1350, maxImages: 10, pdf: false },
  tiktok: { width: 1080, height: 1920, maxImages: 35, pdf: false },
  linkedin: { width: 1080, height: 1350, maxImages: 10, pdf: true },
  x: { width: 1600, height: 900, maxImages: 4, pdf: false },
};
const DEFAULT_OUTPUT = STILL_OUTPUT.instagram!;

/**
 * render.still: a swipe post variant → images (or a LinkedIn PDF) rendered from the Still
 * composition, stored as assets, written back to variant.assetIds + body.renderedAssetIds with a
 * recomputed content hash. Changed files on an approved variant void its approval.
 */
export async function executeRenderStill(deps: VideoDeps, job: { contentItemId: string; variantId: string }): Promise<{ assetIds: string[] } | null> {
  const { db } = deps;
  const [row] = await db
    .select({ v: variants, workspaceId: contentItems.workspaceId, productId: campaigns.productId })
    .from(variants)
    .innerJoin(contentItems, eq(contentItems.id, variants.contentItemId))
    .innerJoin(campaigns, eq(campaigns.id, contentItems.campaignId))
    .where(and(eq(variants.id, job.variantId), eq(variants.contentItemId, job.contentItemId)));
  if (!row) return null; // deleted since it was queued
  const { v, workspaceId, productId } = row;
  const parsed = CarouselVariantBody.safeParse(v.body);
  if (!parsed.success) throw new Error("This swipe post's slides are invalid. Open it and save it again.");
  const body = parsed.data;
  const out = STILL_OUTPUT[v.platform] ?? DEFAULT_OUTPUT;
  const slides = body.spec.slides.slice(0, out.maxImages);
  const brand = await brandFor(db, workspaceId, productId);

  const slideAssetIds = [...new Set(slides.flatMap((s) => (s.assetId ? [s.assetId] : [])))];
  const src = slideAssetIds.length
    ? await db.select().from(assets).where(and(inArray(assets.id, slideAssetIds), eq(assets.workspaceId, workspaceId)))
    : [];
  if (src.length !== slideAssetIds.length) throw new Error("A screenshot used in this swipe post was deleted. Pick another one.");
  const tier = computeTier(src.map<Ingredient>((a) => ({ kind: "asset", origin: a.origin, provenanceTier: a.provenanceTier, mediaKind: a.kind })));

  const dir = await mkdtemp(join(deps.workDir ?? tmpdir(), "mkt-still-"));
  try {
    const assetFiles: Record<string, string> = {};
    for (const a of src) {
      const p = join(dir, `src-${a.id}`);
      await writeFile(p, await deps.storage.get(a.storageKey));
      assetFiles[a.id] = p;
    }
    const paths: string[] = [];
    for (const [i, s] of slides.entries()) {
      const props: StillPropsLike = {
        template: s.template,
        width: out.width,
        height: out.height,
        brand,
        slide: { headline: s.headline, ...(s.body ? { body: s.body } : {}), ...(s.assetId ? { assetId: s.assetId } : {}), index: i + 1, total: slides.length },
      };
      const p = join(dir, `slide-${i + 1}.jpg`);
      await deps.renderer.renderStillImage({ props, assetFiles, outPath: p, imageFormat: "jpeg", jpegQuality: 90 });
      await deps.renderer.writeXmp(p, digitalSourceType(tier));
      paths.push(p);
    }

    const stored: { id: string; sha256: string }[] = [];
    const common = { workspaceId, productId, origin: "template" as const, tier, origination: { purpose: "swipe_post", variantId: v.id, platform: v.platform } };
    if (out.pdf) {
      const pdf = await deps.renderer.buildLinkedInPdf(paths);
      const a = await storeAsset(db, deps.storage, { ...common, kind: "pdf", mime: "application/pdf", ext: "pdf", bytes: pdf });
      stored.push(a);
    } else {
      for (const [i, p] of paths.entries()) {
        const a = await storeAsset(db, deps.storage, {
          ...common,
          kind: "still",
          mime: "image/jpeg",
          ext: "jpg",
          bytes: new Uint8Array(await readFile(p)),
          width: out.width,
          height: out.height,
          xmpWritten: true,
          origination: { ...common.origination, slide: i + 1 },
        });
        stored.push(a);
      }
    }
    for (const a of stored) await linkLineage(db, workspaceId, a.id, slideAssetIds, "rendered_from");

    const assetIds = stored.map((a) => a.id);
    const newBody = { ...body, renderedAssetIds: assetIds };
    const contentHash = variantContentHash({ platform: v.platform, body: newBody, mediaSha256s: stored.map((a) => a.sha256) });
    if (contentHash !== v.contentHash && v.assetIds.length) await deps.voidApprovalsFor([v.id], "The swipe post images changed.");
    await db
      .update(variants)
      .set({ body: newBody as unknown as Record<string, unknown>, assetIds, provenanceTier: tier, contentHash, updatedAt: new Date() })
      .where(and(eq(variants.id, v.id), eq(variants.workspaceId, workspaceId)));
    return { assetIds };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
