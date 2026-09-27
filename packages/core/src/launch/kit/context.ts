import { and, desc, eq, inArray } from "drizzle-orm";
import { KitInputs, type ProductDna } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { bundleById, freezeBundle } from "../../engine/bundle.ts";
import { latestStrategy } from "../../ingest/strategy.ts";
import type { KitAsset, BuildCtx } from "./build.ts";
import { pricesIn, type KitCheckCtx, type KitClaim } from "./checks.ts";

const { launchPlans, launchKits, products, campaigns, claims, productDnaVersions, assets, generationRuns, workspaces } = schema;

// Everything a kit needs to be written, checked or exported, loaded workspace-scoped.

export class KitNotReady extends Error {
  readonly code = "kit_not_ready";
  constructor(message: string) {
    super(message);
    this.name = "KitNotReady";
  }
}

export type KitRow = typeof launchKits.$inferSelect;
export type KitPlanRow = typeof launchPlans.$inferSelect;

export interface KitContext {
  plan: KitPlanRow;
  product: typeof products.$inferSelect;
  timezone: string;
  bundle: { version: number; text: string; dnaVersionId: string };
  dna: ProductDna | null;
  check: KitCheckCtx;
  build: BuildCtx;
}

const BUNDLE_PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
const ASSET_KINDS = ["screenshot", "image", "still"] as const;

/** End of launch day (UTC): facts must stay valid through it. */
export const kitValidThrough = (launchDate: string) => new Date(`${launchDate}T23:59:59.999Z`);

export async function kitPlanFor(db: Db, workspaceId: string, launchPlanId: string): Promise<KitPlanRow | null> {
  const [p] = await db.select().from(launchPlans).where(and(eq(launchPlans.id, launchPlanId), eq(launchPlans.workspaceId, workspaceId)));
  return p ?? null;
}

export async function kitFor(db: Db, workspaceId: string, kitId: string): Promise<KitRow | null> {
  const [k] = await db.select().from(launchKits).where(and(eq(launchKits.id, kitId), eq(launchKits.workspaceId, workspaceId)));
  return k ?? null;
}

/** What the user typed for this kit's last run (stored on the generation run). */
export async function kitInputsFor(db: Db, kit: KitRow): Promise<KitInputs> {
  if (!kit.runId) return {};
  const [run] = await db.select({ input: generationRuns.input }).from(generationRuns).where(and(eq(generationRuns.id, kit.runId), eq(generationRuns.workspaceId, kit.workspaceId)));
  const parsed = KitInputs.safeParse(run?.input.inputs ?? {});
  return parsed.success ? parsed.data : {};
}

export async function loadKitContext(db: Db, kit: KitRow, inputs: KitInputs, now = new Date()): Promise<KitContext> {
  if (!kit.launchPlanId) throw new KitNotReady("This kit isn't part of a launch plan.");
  const plan = await kitPlanFor(db, kit.workspaceId, kit.launchPlanId);
  if (!plan) throw new KitNotReady("The launch plan is gone.");
  const [product] = await db.select().from(products).where(and(eq(products.id, plan.productId), eq(products.workspaceId, kit.workspaceId)));
  if (!product) throw new KitNotReady("The product is gone.");
  const [ws] = await db.select({ timezone: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, kit.workspaceId));

  // The campaign's frozen bundle when there is one, so kits share the package's cached prefix.
  let bundle: { version: number; text: string; dnaVersionId: string } | null = null;
  if (plan.campaignId) {
    const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, plan.campaignId), eq(campaigns.workspaceId, kit.workspaceId)));
    const b = c?.bundleId ? await bundleById(db, kit.workspaceId, c.bundleId) : null;
    if (b) bundle = { version: b.version, text: b.text, dnaVersionId: b.dnaVersionId };
  }
  if (!bundle) {
    const strategy = await latestStrategy(db, product.id);
    if (!strategy || strategy.workspaceId !== kit.workspaceId) throw new KitNotReady("Pick your angles first: the kit is written from your plan.");
    const b = await freezeBundle(db, { workspaceId: kit.workspaceId, productId: product.id, strategyId: strategy.id, platforms: BUNDLE_PLATFORMS, now });
    bundle = { version: b.version, text: b.text, dnaVersionId: strategy.dnaVersionId };
  }

  const [version] = await db.select({ dna: productDnaVersions.dna }).from(productDnaVersions).where(eq(productDnaVersions.id, bundle.dnaVersionId));
  const dna = (version?.dna as unknown as ProductDna | undefined) ?? null;
  const claimRows = await db.select().from(claims).where(and(eq(claims.dnaVersionId, bundle.dnaVersionId), eq(claims.workspaceId, kit.workspaceId)));
  const claimMap = new Map<string, KitClaim>(claimRows.map((c) => [c.ref, { ref: c.ref, kind: c.kind, publicOk: c.publicOk, status: c.status, expiresAt: c.expiresAt }]));

  const knownPrices = new Set<string>();
  for (const t of dna?.offer.pricing.tiers ?? []) for (const p of pricesIn(t.price)) knownPrices.add(p);
  for (const p of pricesIn(dna?.offer.pricing.summary ?? "")) knownPrices.add(p);
  for (const c of claimRows) if (c.kind === "price" && c.publicOk && c.status !== "rejected") for (const p of pricesIn(c.text)) knownPrices.add(p);

  const assetRows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, kit.workspaceId), eq(assets.productId, product.id), inArray(assets.kind, [...ASSET_KINDS])))
    .orderBy(desc(assets.createdAt))
    .limit(60);
  const usable: KitAsset[] = assetRows
    .filter((a) => {
      const l = a.labels as { usefulForMarketing?: boolean; hasPersonalData?: boolean } | null;
      return !a.piiHits && l?.hasPersonalData !== true && l?.usefulForMarketing !== false;
    })
    .slice(0, 40)
    .map((a) => ({ id: a.id, kind: a.kind, label: String((a.labels as { caption?: string } | null)?.caption ?? a.kind) }));

  const site = product.urls.website ?? null;
  return {
    plan,
    product,
    timezone: ws?.timezone ?? "America/New_York",
    bundle,
    dna,
    check: {
      claims: claimMap,
      validThrough: kitValidThrough(plan.launchDate),
      knownPrices,
      competitors: (dna?.market.competitors ?? []).map((c) => c.name),
      inputs,
      assetIds: new Set(usable.map((a) => a.id)),
    },
    build: { productName: dna?.identity.name || product.name, site, campaign: `${product.slug}-launch`, inputs, dna, assets: usable },
  };
}
