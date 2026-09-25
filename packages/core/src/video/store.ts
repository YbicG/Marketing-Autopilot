import { and, eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { sha256, workspacePrefix, type Storage } from "../media/storage.ts";
import type { ProvenanceTier } from "./provenance.ts";

const { assets, assetLineage } = schema;

export type AssetKind = (typeof assets.$inferInsert)["kind"];
export type AssetOrigin = (typeof assets.$inferInsert)["origin"];

export interface NewAsset {
  workspaceId: string;
  productId: string | null;
  kind: AssetKind;
  origin: AssetOrigin;
  tier: ProvenanceTier;
  mime: string;
  ext: string;
  bytes: Uint8Array;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  origination?: Record<string, unknown>;
  licenseRef?: string | null;
  labels?: Record<string, unknown> | null;
  xmpWritten?: boolean;
}

/** Content-addressed: ws/<id>/assets/<sha>.<ext>; the same bytes of the same kind are stored once (unique ws+sha+kind). */
export async function storeAsset(db: Db, storage: Storage, a: NewAsset): Promise<{ id: string; sha256: string; storageKey: string; created: boolean }> {
  const hash = sha256(a.bytes);
  const key = `${workspacePrefix(a.workspaceId)}/assets/${hash}.${a.ext.toLowerCase()}`;
  const [existing] = await db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(and(eq(assets.workspaceId, a.workspaceId), eq(assets.sha256, hash), eq(assets.kind, a.kind)));
  if (existing) return { id: existing.id, sha256: hash, storageKey: existing.storageKey, created: false };

  await storage.put(key, a.bytes);
  const id = uuidv7();
  const [row] = await db
    .insert(assets)
    .values({
      id,
      workspaceId: a.workspaceId,
      productId: a.productId,
      kind: a.kind,
      origin: a.origin,
      provenanceTier: a.tier,
      mime: a.mime,
      width: a.width ?? null,
      height: a.height ?? null,
      sha256: hash,
      storageKey: key,
      origination: a.origination ?? {},
      labels: a.labels ?? null,
      durationMs: a.durationMs == null ? null : Math.round(a.durationMs),
      sizeBytes: a.bytes.byteLength,
      licenseRef: a.licenseRef ?? null,
      xmpWritten: a.xmpWritten ?? false,
    })
    .onConflictDoNothing()
    .returning({ id: assets.id });
  if (row) return { id: row.id, sha256: hash, storageKey: key, created: true };
  // Lost a race with an identical insert.
  const [again] = await db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(and(eq(assets.workspaceId, a.workspaceId), eq(assets.sha256, hash), eq(assets.kind, a.kind)));
  return { id: again!.id, sha256: hash, storageKey: again!.storageKey, created: false };
}

export async function linkLineage(db: Db, workspaceId: string, assetId: string, parents: string[], relation: string): Promise<void> {
  const unique = [...new Set(parents)].filter((p) => p !== assetId);
  if (!unique.length) return;
  await db
    .insert(assetLineage)
    .values(unique.map((parentAssetId) => ({ id: uuidv7(), workspaceId, assetId, parentAssetId, relation })))
    .onConflictDoNothing();
}
