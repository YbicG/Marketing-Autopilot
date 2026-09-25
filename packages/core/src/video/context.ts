import { and, desc, eq, inArray } from "drizzle-orm";
import type { BrandSpec } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";

const { contentItems, campaigns, campaignBundles, products, angles, claims, assets, sources, sourceArtifacts } = schema;

export type ContentItemRow = typeof contentItems.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;

/** Kinds a video may show: real screens only (§5.6 "never AI-generate product UI"). */
export const FOOTAGE_KINDS = ["screenshot", "image", "recording"] as const;

export interface VideoContext {
  item: ContentItemRow;
  campaign: typeof campaigns.$inferSelect;
  product: typeof products.$inferSelect;
  /** The frozen cached prefix (§5.0), or a short fallback when the campaign has none yet. */
  bundleText: string;
  angle: Record<string, unknown> | null;
  /** Every claim of the current DNA version (QA checks public + still valid). */
  claims: ClaimRow[];
  publicClaims: ClaimRow[];
  /** Captured/uploaded screenshots and recordings of the product with no personal data. */
  footage: AssetRow[];
  brand: BrandSpec;
}

export class VideoItemMissing extends Error {
  readonly code = "not_found";
  constructor() {
    super("That video isn't there any more.");
    this.name = "VideoItemMissing";
  }
}

/** Workspace-scoped load of everything a video item's steps read. */
export async function loadVideoContext(db: Db, workspaceId: string, contentItemId: string, now = new Date()): Promise<VideoContext> {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, contentItemId), eq(contentItems.workspaceId, workspaceId)));
  if (!item) throw new VideoItemMissing();
  const [campaign] = await db.select().from(campaigns).where(and(eq(campaigns.id, item.campaignId), eq(campaigns.workspaceId, workspaceId)));
  if (!campaign) throw new VideoItemMissing();
  const [product] = await db.select().from(products).where(and(eq(products.id, campaign.productId), eq(products.workspaceId, workspaceId)));
  if (!product) throw new VideoItemMissing();

  let bundleText = `Product: ${product.name}`;
  if (campaign.bundleId) {
    const [b] = await db.select().from(campaignBundles).where(and(eq(campaignBundles.id, campaign.bundleId), eq(campaignBundles.workspaceId, workspaceId)));
    if (b) bundleText = b.text;
  }
  let angle: Record<string, unknown> | null = null;
  if (item.angleId) {
    const [a] = await db.select().from(angles).where(and(eq(angles.id, item.angleId), eq(angles.workspaceId, workspaceId)));
    angle = a?.card ?? null;
  }

  const allClaims = product.currentDnaVersionId
    ? await db.select().from(claims).where(and(eq(claims.dnaVersionId, product.currentDnaVersionId), eq(claims.workspaceId, workspaceId)))
    : [];
  const publicClaims = allClaims.filter((c) => isUsableClaim(c, now));

  const footage = (
    await db
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.productId, product.id), inArray(assets.kind, [...FOOTAGE_KINDS])))
  ).filter((a) => (a.origin === "captured" || a.origin === "uploaded") && !a.piiHits && (a.labels as { hasPersonalData?: boolean } | null)?.hasPersonalData !== true);

  return { item, campaign, product, bundleText, angle, claims: allClaims, publicClaims, footage, brand: await brandFor(db, workspaceId, product.id) };
}

/** public_ok, not rejected, not expired (comparisons expire after 30 days). */
export function isUsableClaim(c: Pick<ClaimRow, "publicOk" | "status" | "expiresAt">, now: Date): boolean {
  return c.publicOk && c.status !== "rejected" && (!c.expiresAt || c.expiresAt > now);
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DEFAULT_BRAND: BrandSpec = { colors: ["#111827", "#ffffff"], font: "Inter", logoAssetId: null };

/** Brand colours from the website capture. Fonts: renders use bundled Inter only (deterministic). */
export async function brandFor(db: Db, workspaceId: string, productId: string): Promise<BrandSpec> {
  const rows = await db
    .select({ meta: sourceArtifacts.meta })
    .from(sourceArtifacts)
    .innerJoin(sources, eq(sources.id, sourceArtifacts.sourceId))
    .where(and(eq(sources.productId, productId), eq(sourceArtifacts.workspaceId, workspaceId), eq(sourceArtifacts.kind, "brand")))
    .orderBy(desc(sourceArtifacts.createdAt))
    .limit(1);
  const colors = ((rows[0]?.meta.colors as unknown[] | undefined) ?? []).filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, 6);
  return colors.length ? { ...DEFAULT_BRAND, colors } : DEFAULT_BRAND;
}

export function describeFootage(a: AssetRow): string {
  const l = (a.labels ?? {}) as { caption?: string; kind?: string };
  const dims = a.width && a.height ? `${a.width}×${a.height}` : "";
  const dur = a.durationMs ? `, ${(a.durationMs / 1000).toFixed(1)} s` : "";
  return `${a.id}: ${a.kind}${l.kind ? `/${l.kind}` : ""} ${dims}${dur} — ${l.caption ?? String(a.origination.path ?? a.origination.pageUrl ?? "")}`.trim();
}
