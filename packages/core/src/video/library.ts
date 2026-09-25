// The project's asset library (the Assets page): every screenshot, recording and final file with
// where it came from and its provenance tier. Workspace-scoped; never returns storage keys.

import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";

const { assets } = schema;

export interface LibraryAsset {
  id: string;
  kind: string;
  origin: string;
  tier: "A" | "B" | "C";
  mime: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  hasPersonalData: boolean;
  /** Page path for captures, the file name for uploads. */
  from: string | null;
  createdAt: string;
}

export interface LibraryCounts {
  total: number;
  byTier: Record<"A" | "B" | "C", number>;
  personalData: number;
}

function fromOf(o: Record<string, unknown>): string | null {
  for (const k of ["pageUrl", "path", "filename", "fileName", "url"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  }
  return null;
}

/** Newest first, capped at `limit` (default 200). */
export async function projectAssets(db: Db, workspaceId: string, productId: string, opts: { limit?: number } = {}): Promise<{ assets: LibraryAsset[]; counts: LibraryCounts }> {
  const where = and(eq(assets.workspaceId, workspaceId), eq(assets.productId, productId));
  const [rows, agg] = await Promise.all([
    db
      .select({
        id: assets.id,
        kind: assets.kind,
        origin: assets.origin,
        tier: assets.provenanceTier,
        mime: assets.mime,
        width: assets.width,
        height: assets.height,
        durationMs: assets.durationMs,
        sizeBytes: assets.sizeBytes,
        piiHits: assets.piiHits,
        origination: assets.origination,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .where(where)
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(Math.min(Math.max(opts.limit ?? 200, 1), 1000)),
    db
      .select({ tier: assets.provenanceTier, n: sql<number>`count(*)::int`, pii: sql<number>`count(*) filter (where ${assets.piiHits})::int` })
      .from(assets)
      .where(where)
      .groupBy(assets.provenanceTier),
  ]);
  const counts: LibraryCounts = { total: 0, byTier: { A: 0, B: 0, C: 0 }, personalData: 0 };
  for (const a of agg) {
    counts.byTier[a.tier] = Number(a.n);
    counts.total += Number(a.n);
    counts.personalData += Number(a.pii);
  }
  return {
    counts,
    assets: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      origin: r.origin,
      tier: r.tier,
      mime: r.mime,
      width: r.width,
      height: r.height,
      durationMs: r.durationMs,
      sizeBytes: r.sizeBytes,
      hasPersonalData: r.piiHits,
      from: fromOf(r.origination ?? {}),
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  };
}
