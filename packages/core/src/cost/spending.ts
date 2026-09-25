import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { periodMonth } from "./ledger.ts";

const { generationRuns, products, providerCalls, spendLedger } = schema;

/** §7.3 Spending page: read-only views over provider_calls and the ledger for one month. */

export function monthRange(month = periodMonth()): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must look like 2026-10, got ${month}`);
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

/** Settled calls count what they cost; calls still in flight count their reservation. */
const amount = sql<number>`coalesce(sum(case
  when ${providerCalls.status} = 'settled' then coalesce(${providerCalls.actualMicros}, 0)
  when ${providerCalls.status} = 'reserved' then ${providerCalls.estMicros}
  else 0 end), 0)`.mapWith(Number);
const inFlight = sql<number>`coalesce(sum(case when ${providerCalls.status} = 'reserved' then ${providerCalls.estMicros} else 0 end), 0)`.mapWith(Number);
const count = sql<number>`count(*)`.mapWith(Number);

export interface SpendGroup {
  key: string;
  label: string;
  micros: number;
  inFlightMicros: number;
  calls: number;
  /** Project slug, for the by-project rows. */
  slug?: string | null;
}

export interface SpendBreakdown {
  month: string;
  totalMicros: number;
  inFlightMicros: number;
  byProject: SpendGroup[];
  byProvider: SpendGroup[];
  byFeature: SpendGroup[];
  /** Subscription (`external`) ledger rows this month, shown separately (§7.1 step 8). */
  externalMicros: number;
}

const byAmount = (a: SpendGroup, b: SpendGroup) => b.micros - a.micros || a.label.localeCompare(b.label);

export async function spendBreakdown(db: Db, workspaceId: string, month = periodMonth()): Promise<SpendBreakdown> {
  const { start, end } = monthRange(month);
  const where = and(eq(providerCalls.workspaceId, workspaceId), gte(providerCalls.createdAt, start), lt(providerCalls.createdAt, end));

  const [providers, features, projects, external] = await Promise.all([
    db
      .select({ key: providerCalls.provider, micros: amount, inFlight, calls: count })
      .from(providerCalls)
      .where(where)
      .groupBy(providerCalls.provider),
    db
      .select({ key: providerCalls.feature, micros: amount, inFlight, calls: count })
      .from(providerCalls)
      .where(where)
      .groupBy(providerCalls.feature),
    db
      .select({ id: products.id, name: products.name, slug: products.slug, micros: amount, inFlight, calls: count })
      .from(providerCalls)
      .leftJoin(generationRuns, and(eq(generationRuns.id, providerCalls.runId), eq(generationRuns.workspaceId, workspaceId)))
      .leftJoin(products, and(eq(products.id, generationRuns.productId), eq(products.workspaceId, workspaceId)))
      .where(where)
      .groupBy(products.id, products.name, products.slug),
    db
      .select({ micros: sql<number>`coalesce(sum(${spendLedger.micros}), 0)`.mapWith(Number) })
      .from(spendLedger)
      .where(and(eq(spendLedger.workspaceId, workspaceId), eq(spendLedger.kind, "external"), eq(spendLedger.periodMonth, month))),
  ]);

  const plain = (r: { key: string; micros: number; inFlight: number; calls: number }): SpendGroup => ({
    key: r.key,
    label: r.key,
    micros: r.micros,
    inFlightMicros: r.inFlight,
    calls: r.calls,
  });
  const byProvider = providers.map(plain).sort(byAmount);
  return {
    month,
    totalMicros: byProvider.reduce((n, g) => n + g.micros, 0),
    inFlightMicros: byProvider.reduce((n, g) => n + g.inFlightMicros, 0),
    byProvider,
    byFeature: features.map(plain).sort(byAmount),
    byProject: projects
      .map((r) => ({
        key: r.id ?? "none",
        label: r.name ?? "Not tied to a project",
        slug: r.slug,
        micros: r.micros,
        inFlightMicros: r.inFlight,
        calls: r.calls,
      }))
      .sort(byAmount),
    externalMicros: external[0]?.micros ?? 0,
  };
}

export interface LedgerEntry {
  id: string;
  createdAt: Date;
  settledAt: Date | null;
  status: "reserved" | "settled" | "released";
  feature: string;
  provider: string;
  model: string | null;
  estMicros: number;
  actualMicros: number | null;
  runId: string | null;
  runKind: string | null;
  productName: string | null;
  productSlug: string | null;
  error: string | null;
}

/** Newest first: each paid call from reserved to settled (or released), estimate vs actual. */
export async function ledgerEntries(
  db: Db,
  workspaceId: string,
  opts: { month?: string; limit?: number } = {},
): Promise<LedgerEntry[]> {
  const { start, end } = monthRange(opts.month);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await db
    .select({
      id: providerCalls.id,
      createdAt: providerCalls.createdAt,
      settledAt: providerCalls.settledAt,
      status: providerCalls.status,
      feature: providerCalls.feature,
      provider: providerCalls.provider,
      servedModel: providerCalls.servedModel,
      requestedModel: providerCalls.requestedModel,
      estMicros: providerCalls.estMicros,
      actualMicros: providerCalls.actualMicros,
      runId: providerCalls.runId,
      runKind: generationRuns.kind,
      productName: products.name,
      productSlug: products.slug,
      error: providerCalls.error,
    })
    .from(providerCalls)
    .leftJoin(generationRuns, and(eq(generationRuns.id, providerCalls.runId), eq(generationRuns.workspaceId, workspaceId)))
    .leftJoin(products, and(eq(products.id, generationRuns.productId), eq(products.workspaceId, workspaceId)))
    .where(and(eq(providerCalls.workspaceId, workspaceId), gte(providerCalls.createdAt, start), lt(providerCalls.createdAt, end)))
    .orderBy(desc(providerCalls.createdAt), desc(providerCalls.id))
    .limit(limit);
  return rows.map(({ servedModel, requestedModel, ...r }) => ({ ...r, model: servedModel ?? requestedModel ?? null }));
}
