import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { ensurePeriods, reserve } from "../cost/ledger.ts";
import { deleteWorkspace, ensureWorkspaceForUser, isAllowedLogin, parseAllowlist } from "./index.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("allowlist", () => {
  it("is case-insensitive and empty means nobody", () => {
    const allow = parseAllowlist(" CJ-dev , other ");
    expect(isAllowedLogin("cj-dev", allow)).toBe(true);
    expect(isAllowedLogin("stranger", allow)).toBe(false);
    expect(isAllowedLogin(undefined, allow)).toBe(false);
    expect(isAllowedLogin("cj-dev", parseAllowlist(""))).toBe(false);
  });
});

describe("workspaces", () => {
  it("creates one workspace per user and deleting it cascades", async () => {
    await db.insert(schema.users).values({ id: "u1", name: "CJ", email: "cj@example.com" });
    const ws = await ensureWorkspaceForUser(db, { id: "u1", name: "CJ" });
    expect(await ensureWorkspaceForUser(db, { id: "u1", name: "CJ" })).toBe(ws);

    const [pid] = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 1_000_000 }]);
    await reserve(db, { workspaceId: ws, budgetPeriodIds: [pid!], estMicros: 10, feature: "t", provider: "anthropic" });

    await db.insert(schema.generationRuns).values({ id: uuidv7(), workspaceId: ws, kind: "m0_summary", status: "queued", input: {}, capMicros: 1 });
    await db.insert(schema.sessions).values({ id: "s1", userId: "u1", token: "t1", expiresAt: new Date(Date.now() + 60_000) });
    const patId = uuidv7();
    await db.insert(schema.personalAccessTokens).values({ id: patId, workspaceId: ws, name: "agent", prefix: "0badcafe", tokenHash: "h", scopes: ["read"], createdBy: "u1" });
    const productId = uuidv7();
    const dnaVersionId = uuidv7();
    await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "p", name: "P", urls: {} });
    await db.insert(schema.productDnaVersions).values({ id: dnaVersionId, workspaceId: ws, productId, version: 1, dna: {}, fields: {}, sourceMap: {} });
    await db.insert(schema.dnaChangeRequests).values({ id: uuidv7(), workspaceId: ws, productId, dnaVersionId, path: "identity.oneLiner", value: "x", patId });

    await deleteWorkspace(db, ws, "u1");
    for (const t of [
      schema.workspaceMembers,
      schema.budgetPeriods,
      schema.providerCalls,
      schema.spendLedger,
      schema.auditLog,
      schema.generationRuns,
      schema.personalAccessTokens,
      schema.dnaChangeRequests,
    ]) {
      expect(await db.select().from(t).where(eq(t.workspaceId, ws))).toHaveLength(0);
    }
    // The user survives (so signing in again starts fresh), but every session is revoked.
    expect(await db.select().from(schema.users).where(eq(schema.users.id, "u1"))).toHaveLength(1);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, "u1"))).toHaveLength(0);
    expect(await ensureWorkspaceForUser(db, { id: "u1", name: "CJ" })).not.toBe(ws);
  });
});
