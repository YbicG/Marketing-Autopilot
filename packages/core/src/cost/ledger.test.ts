import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sum } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { BudgetExceeded } from "./errors.ts";
import { ensurePeriods, release, reserve, settle } from "./ledger.ts";
import { BilledFailure, runPaidCall } from "./run-paid-call.ts";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function newWorkspace() {
  const id = uuidv7();
  await db.insert(schema.workspaces).values({ id, name: "test" });
  return id;
}

async function period(id: string) {
  const [p] = await db.select().from(schema.budgetPeriods).where(eq(schema.budgetPeriods.id, id));
  return p!;
}

const call = (workspaceId: string, budgetPeriodIds: string[], estMicros: number) => ({
  workspaceId,
  budgetPeriodIds,
  estMicros,
  feature: "test",
  provider: "anthropic",
});

describe("reserve", () => {
  it("never over-reserves under 50 parallel attempts", async () => {
    const ws = await newWorkspace();
    const [pid] = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 1_000_000 }]);
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => reserve(db, call(ws, [pid!], 30_000))));

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toBe(33); // floor(1_000_000 / 30_000)
    expect(rejected.every((r) => r.status === "rejected" && r.reason instanceof BudgetExceeded)).toBe(true);
    expect((await period(pid!)).reservedMicros).toBe(33 * 30_000);
  });

  it("rejects a $0.01 run cap and rolls back the scopes that had room", async () => {
    const ws = await newWorkspace();
    const [globalId, runId] = await ensurePeriods(db, ws, [
      { scope: "global_month", capMicros: 60_000_000 },
      { scope: "run", scopeRef: "run-1", capMicros: 10_000 },
    ]);
    const err = await reserve(db, call(ws, [globalId!, runId!], 20_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect((err as BudgetExceeded).scopes).toEqual(["run:run-1"]);
    expect((await period(globalId!)).reservedMicros).toBe(0);
    const calls = await db.select().from(schema.providerCalls).where(eq(schema.providerCalls.workspaceId, ws));
    expect(calls).toHaveLength(0);
  });

  it("refuses to reserve against another workspace's budget", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const [pid] = await ensurePeriods(db, a, [{ scope: "global_month", capMicros: 1_000_000 }]);
    await expect(reserve(db, call(b, [pid!], 1))).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe("settle / release", () => {
  it("moves the reservation into spent at the actual cost, with a balanced ledger", async () => {
    const ws = await newWorkspace();
    const [pid] = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 1_000_000 }]);
    const id = await reserve(db, call(ws, [pid!], 50_000));
    await settle(db, id, { actualMicros: 12_345, servedModel: "claude-opus-5" });
    await settle(db, id, { actualMicros: 99_999 }); // second settle is a no-op

    const p = await period(pid!);
    expect(p).toMatchObject({ reservedMicros: 0, spentMicros: 12_345 });

    const rows = await db.select().from(schema.spendLedger).where(eq(schema.spendLedger.providerCallId, id));
    expect(rows.map((r) => [r.kind, r.micros]).sort()).toEqual([
      ["release", -50_000],
      ["reserve", 50_000],
      ["settle", 12_345],
    ]);
  });

  it("release returns the whole reservation and bills nothing", async () => {
    const ws = await newWorkspace();
    const [pid] = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 1_000_000 }]);
    const id = await reserve(db, call(ws, [pid!], 50_000));
    await release(db, id, "boom");
    expect(await period(pid!)).toMatchObject({ reservedMicros: 0, spentMicros: 0 });
  });
});

describe("runPaidCall", () => {
  it("settles on success, releases on a plain failure, bills a BilledFailure", async () => {
    const ws = await newWorkspace();
    const [pid] = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 1_000_000 }]);
    const input = call(ws, [pid!], 40_000);

    await expect(runPaidCall(db, input, async () => ({ result: "hi", actualMicros: 1_000 }))).resolves.toBe("hi");
    await expect(runPaidCall(db, input, async () => Promise.reject(new Error("network")))).rejects.toThrow("network");
    const original = new Error("stream cut");
    await expect(
      runPaidCall(db, input, async () => Promise.reject(new BilledFailure({ actualMicros: 2_500 }, original))),
    ).rejects.toBe(original);

    expect(await period(pid!)).toMatchObject({ reservedMicros: 0, spentMicros: 3_500 });
    const [total] = await db
      .select({ s: sum(schema.spendLedger.micros) })
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.workspaceId, ws));
    expect(Number(total!.s)).toBe(3_500); // reserve + release cancel out; settles remain
  });
});
