import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { ensurePeriods, periodMonth } from "./ledger.ts";

const { budgetPeriods } = schema;

/** D10 / §7.2: an agent token may spend up to $0.50 in one call and $10 in a month without a person confirming. */
export const PAT_CALL_MAX_MICROS = 500_000;
export const PAT_MONTHLY_CAP_MICROS = 10_000_000;

/** The token's own budget scope (scope "pat", scope_ref = the token id), created on first use. */
export async function patPeriod(db: Db, workspaceId: string, patId: string, month = periodMonth()) {
  const [id] = await ensurePeriods(db, workspaceId, [{ scope: "pat", scopeRef: patId, capMicros: PAT_MONTHLY_CAP_MICROS }], month);
  const [row] = await db
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.id, id!), eq(budgetPeriods.workspaceId, workspaceId)));
  return row!;
}
