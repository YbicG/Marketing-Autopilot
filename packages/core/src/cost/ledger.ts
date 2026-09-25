import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { BudgetExceeded } from "./errors.ts";

const { budgetAlerts, budgetPeriods, providerCalls, spendLedger } = schema;

export const ALERT_THRESHOLDS = [50, 80, 100] as const;

/** Thresholds (percent of cap) passed when spend moves from `before` to `after`. */
export function crossedThresholds(before: number, after: number, cap: number): number[] {
  if (cap <= 0) return [];
  return ALERT_THRESHOLDS.filter((pct) => before * 100 < pct * cap && after * 100 >= pct * cap);
}

export function periodMonth(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export interface PeriodSpec {
  scope: "global_month" | "run" | "pat" | "ads";
  scopeRef?: string;
  capMicros: number;
}

/** Get or create the budget rows a call reserves against. Existing caps are left untouched. */
export async function ensurePeriods(
  db: Db,
  workspaceId: string,
  specs: PeriodSpec[],
  month = periodMonth(),
): Promise<string[]> {
  const ids: string[] = [];
  for (const s of specs) {
    const [row] = await db
      .insert(budgetPeriods)
      .values({
        id: uuidv7(),
        workspaceId,
        scope: s.scope,
        scopeRef: s.scopeRef ?? "",
        periodMonth: month,
        capMicros: s.capMicros,
      })
      .onConflictDoUpdate({
        target: [budgetPeriods.workspaceId, budgetPeriods.scope, budgetPeriods.scopeRef, budgetPeriods.periodMonth],
        set: { capMicros: sql`${budgetPeriods.capMicros}` }, // no-op, so RETURNING yields the existing row
      })
      .returning({ id: budgetPeriods.id });
    ids.push(row!.id);
  }
  return ids;
}

export interface ReserveInput {
  workspaceId: string;
  budgetPeriodIds: string[];
  estMicros: number;
  feature: string;
  provider: string;
  requestedModel?: string;
  runId?: string;
}

/**
 * D5: one transaction. A conditional UPDATE on every scope, then the provider_calls and ledger
 * rows. If any scope lacks headroom, the row count falls short and nothing is written.
 * Ids are sorted so concurrent multi-scope reservations lock rows in the same order.
 */
export async function reserve(db: Db, input: ReserveInput): Promise<string> {
  const ids = [...new Set(input.budgetPeriodIds)].sort();
  if (ids.length === 0) throw new Error("reserve() needs at least one budget scope");
  assertMicros(input.estMicros, "estMicros");

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(budgetPeriods)
      .set({ reservedMicros: sql`${budgetPeriods.reservedMicros} + ${input.estMicros}` })
      .where(
        and(
          inArray(budgetPeriods.id, ids),
          eq(budgetPeriods.workspaceId, input.workspaceId),
          sql`${budgetPeriods.spentMicros} + ${budgetPeriods.reservedMicros} + ${input.estMicros} <= ${budgetPeriods.capMicros}`,
        ),
      )
      .returning({ id: budgetPeriods.id, periodMonth: budgetPeriods.periodMonth });

    if (updated.length !== ids.length) {
      const ok = new Set(updated.map((r) => r.id));
      const missing = ids.filter((id) => !ok.has(id));
      const blocked = await tx
        .select({ scope: budgetPeriods.scope, ref: budgetPeriods.scopeRef })
        .from(budgetPeriods)
        .where(inArray(budgetPeriods.id, missing));
      // Throwing rolls back the partial reservation on the scopes that did have headroom.
      throw new BudgetExceeded(
        blocked.length ? blocked.map((b) => (b.ref ? `${b.scope}:${b.ref}` : b.scope)) : ["unknown_scope"],
        input.estMicros,
      );
    }

    const callId = uuidv7();
    await tx.insert(providerCalls).values({
      id: callId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      feature: input.feature,
      provider: input.provider,
      requestedModel: input.requestedModel,
      status: "reserved",
      budgetPeriodIds: ids,
      estMicros: input.estMicros,
    });
    await tx.insert(spendLedger).values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      providerCallId: callId,
      kind: "reserve",
      micros: input.estMicros,
      periodMonth: updated[0]!.periodMonth,
    });
    return callId;
  });
}

export interface SettleInput {
  actualMicros: number;
  serverToolFeesMicros?: number;
  servedModel?: string;
  usage?: Record<string, unknown>;
  providerRequestId?: string;
}

/** Release the reservation and record the actual cost, in one transaction. A second settle is a no-op. */
export async function settle(db: Db, callId: string, s: SettleInput): Promise<void> {
  await finish(db, callId, "settled", s);
}

/** The call failed before anything was billed: release only. */
export async function release(db: Db, callId: string, error?: string): Promise<void> {
  await finish(db, callId, "released", { actualMicros: 0 }, error);
}

async function finish(db: Db, callId: string, status: "settled" | "released", s: SettleInput, error?: string) {
  assertMicros(s.actualMicros, "actualMicros");
  await db.transaction(async (tx) => {
    // Claiming the row with a status guard makes a repeated settle or release a no-op.
    const [call] = await tx
      .update(providerCalls)
      .set({
        status,
        actualMicros: s.actualMicros,
        serverToolFeesMicros: s.serverToolFeesMicros ?? 0,
        servedModel: s.servedModel,
        usage: s.usage,
        providerRequestId: s.providerRequestId,
        error,
        settledAt: new Date(),
      })
      .where(and(eq(providerCalls.id, callId), eq(providerCalls.status, "reserved")))
      .returning();
    if (!call) return;

    const periods = await tx
      .update(budgetPeriods)
      .set({
        reservedMicros: sql`${budgetPeriods.reservedMicros} - ${call.estMicros}`,
        spentMicros: sql`${budgetPeriods.spentMicros} + ${s.actualMicros}`,
      })
      .where(inArray(budgetPeriods.id, call.budgetPeriodIds))
      .returning();

    // §7.1 step 7: crossing 50/80/100% of the monthly limit writes an alert once per threshold.
    const alerts = periods
      .filter((p) => p.scope === "global_month")
      .flatMap((p) =>
        crossedThresholds(p.spentMicros - s.actualMicros, p.spentMicros, p.capMicros).map((pct) => ({
          id: uuidv7(),
          workspaceId: p.workspaceId,
          budgetPeriodId: p.id,
          thresholdPct: pct,
          spentMicros: p.spentMicros,
          capMicros: p.capMicros,
        })),
      );
    if (alerts.length) await tx.insert(budgetAlerts).values(alerts).onConflictDoNothing();

    const base = { workspaceId: call.workspaceId, providerCallId: callId, periodMonth: periodMonth(call.createdAt) };
    const rows: (typeof spendLedger.$inferInsert)[] = [
      { ...base, id: uuidv7(), kind: "release", micros: -call.estMicros },
    ];
    if (status === "settled") rows.push({ ...base, id: uuidv7(), kind: "settle", micros: s.actualMicros });
    await tx.insert(spendLedger).values(rows);
  });
}

function assertMicros(n: number, name: string) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
}

export interface MonthSpend {
  spentMicros: number;
  reservedMicros: number;
  capMicros: number;
}

/** The header meter: this month's global scope. Before the first paid call there is no row yet. */
export async function monthSpend(db: Db, workspaceId: string, fallbackCapMicros: number, month = periodMonth()): Promise<MonthSpend> {
  const [row] = await db
    .select()
    .from(budgetPeriods)
    .where(
      and(
        eq(budgetPeriods.workspaceId, workspaceId),
        eq(budgetPeriods.scope, "global_month"),
        eq(budgetPeriods.scopeRef, ""),
        eq(budgetPeriods.periodMonth, month),
      ),
    );
  return row
    ? { spentMicros: row.spentMicros, reservedMicros: row.reservedMicros, capMicros: row.capMicros }
    : { spentMicros: 0, reservedMicros: 0, capMicros: fallbackCapMicros };
}

export interface BudgetAlert {
  id: string;
  thresholdPct: number;
  spentMicros: number;
  capMicros: number;
  createdAt: Date;
}

/** Undismissed alerts for this month's limit, newest first (the header toast). */
export async function openAlerts(db: Db, workspaceId: string, month = periodMonth()): Promise<BudgetAlert[]> {
  return db
    .select({
      id: budgetAlerts.id,
      thresholdPct: budgetAlerts.thresholdPct,
      spentMicros: budgetAlerts.spentMicros,
      capMicros: budgetAlerts.capMicros,
      createdAt: budgetAlerts.createdAt,
    })
    .from(budgetAlerts)
    .innerJoin(budgetPeriods, eq(budgetPeriods.id, budgetAlerts.budgetPeriodId))
    .where(
      and(
        eq(budgetAlerts.workspaceId, workspaceId),
        eq(budgetPeriods.periodMonth, month),
        sql`${budgetAlerts.dismissedAt} is null`,
      ),
    )
    .orderBy(sql`${budgetAlerts.thresholdPct} desc`);
}

export async function dismissAlerts(db: Db, workspaceId: string): Promise<void> {
  await db
    .update(budgetAlerts)
    .set({ dismissedAt: new Date() })
    .where(and(eq(budgetAlerts.workspaceId, workspaceId), sql`${budgetAlerts.dismissedAt} is null`));
}
