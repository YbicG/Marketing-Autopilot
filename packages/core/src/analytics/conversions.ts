import { and, eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";

const { conversionSnapshots, products } = schema;

/** One day of first-party counts for one UTM combination (SyllaCal's aggregate endpoint; no personal data). */
export interface ConversionRow {
  day: string;
  utmSource?: string;
  utmContent?: string;
  utmTerm?: string;
  visits: number;
  signups: number;
  purchases: number;
}

export interface FirstPartyClient {
  daily(input: { productSlug: string; from: string; to: string }): Promise<ConversionRow[]>;
}

export interface ConversionDeps {
  db: Db;
  /** null = this product has no first-party endpoint ("just tag my links"). */
  clientFor: (product: typeof products.$inferSelect) => FirstPartyClient | null;
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** maint.conversions_pull (daily): re-reads the last `days` days so late-arriving counts are corrected. */
export async function pullConversions(deps: ConversionDeps, opts: { days?: number; workspaceId?: string } = {}): Promise<{ products: number; rows: number }> {
  const now = deps.now?.() ?? new Date();
  const from = iso(new Date(now.getTime() - (opts.days ?? 3) * 86_400_000));
  const to = iso(now);
  const list = await deps.db
    .select()
    .from(products)
    .where(and(eq(products.status, "active"), ...(opts.workspaceId ? [eq(products.workspaceId, opts.workspaceId)] : [])));
  let n = 0;
  let touched = 0;
  for (const product of list) {
    const client = deps.clientFor(product);
    if (!client) continue;
    touched++;
    const rows = await client.daily({ productSlug: product.slug, from, to });
    for (const r of rows) {
      if (!DAY.test(r.day)) continue;
      const counts = {
        visits: Math.max(0, Math.round(r.visits)),
        signups: Math.max(0, Math.round(r.signups)),
        purchases: Math.max(0, Math.round(r.purchases)),
      };
      await deps.db
        .insert(conversionSnapshots)
        .values({
          id: uuidv7(),
          workspaceId: product.workspaceId,
          productId: product.id,
          day: r.day,
          utmSource: r.utmSource ?? "",
          utmContent: r.utmContent ?? "",
          utmTerm: r.utmTerm ?? "",
          ...counts,
        })
        .onConflictDoUpdate({
          target: [
            conversionSnapshots.productId,
            conversionSnapshots.day,
            conversionSnapshots.utmSource,
            conversionSnapshots.utmContent,
            conversionSnapshots.utmTerm,
          ],
          set: counts,
        });
      n++;
    }
  }
  return { products: touched, rows: n };
}
