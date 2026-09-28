import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { uiSessionFromCookie, type UiSession } from "../publishing/approvals.ts";
import { activePat, hashPat, listPats, mintPat, PAT_RE, revokePat, verifyPat } from "./pat.ts";

let db: Db;
let close: () => Promise<void>;
let session: UiSession;
const NOW = new Date("2026-09-28T12:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  session = uiSessionFromCookie({ userId: "user-1", workspaceId: ws, originChecked: true, csrfChecked: true });
});
afterAll(() => close());

describe("personal access tokens", () => {
  it("stores only the hash; the token is shown once and verifies", async () => {
    const m = await mintPat(db, session, { name: "Claude Code", scopes: ["read", "draft"] }, NOW);
    expect(m.token).toMatch(PAT_RE);
    expect(m.token.startsWith(`mkt_pat_${m.prefix}_`)).toBe(true);
    const [row] = await db.select().from(schema.personalAccessTokens).where(eq(schema.personalAccessTokens.id, m.id));
    expect(row!.tokenHash).toBe(hashPat(m.token));
    expect(JSON.stringify(row)).not.toContain(m.token.slice(-32));

    const later = new Date(NOW.getTime() + 60_000);
    const ctx = await verifyPat(db, m.token, later);
    expect(ctx).toEqual({ patId: m.id, workspaceId: session.workspaceId, scopes: ["read", "draft"], createdBy: "user-1" });
    const [used] = await db.select().from(schema.personalAccessTokens).where(eq(schema.personalAccessTokens.id, m.id));
    expect(used!.lastUsedAt?.toISOString()).toBe(later.toISOString());

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entity, `pat:${m.id}`));
    expect(audit.map((a) => a.action)).toEqual(["pat.create"]);
    expect(JSON.stringify(audit)).not.toContain(m.token);
  });

  it("a wrong secret with the right prefix, a malformed token or an unknown one is refused", async () => {
    const m = await mintPat(db, session, { name: "x", scopes: ["read"] }, NOW);
    const flipped = m.token.slice(0, -1) + (m.token.endsWith("0") ? "1" : "0");
    expect(await verifyPat(db, flipped, NOW)).toBeNull();
    expect(await verifyPat(db, "mkt_pat_nothex", NOW)).toBeNull();
    expect(await verifyPat(db, `mkt_pat_00000000_${"a".repeat(32)}`, NOW)).toBeNull();
    expect(await verifyPat(db, "", NOW)).toBeNull();
  });

  it("revoked and expired tokens are unauthorized", async () => {
    const m = await mintPat(db, session, { name: "revoke me", scopes: ["read"] }, NOW);
    expect(await revokePat(db, session, m.id, NOW)).toBe(true);
    expect(await revokePat(db, session, m.id, NOW)).toBe(false);
    expect(await verifyPat(db, m.token, NOW)).toBeNull();
    expect(await activePat(db, session.workspaceId, m.id, NOW)).toBeNull();

    const e = await mintPat(db, session, { name: "short", scopes: ["read"], expiresAt: new Date(NOW.getTime() + 3_600_000) }, NOW);
    expect(await verifyPat(db, e.token, new Date(NOW.getTime() + 60_000))).not.toBeNull();
    expect(await verifyPat(db, e.token, new Date(NOW.getTime() + 3_600_000))).toBeNull();
  });

  it("another workspace can't revoke it, and the list never shows the secret", async () => {
    const m = await mintPat(db, session, { name: "mine", scopes: ["read"] }, NOW);
    const other = uiSessionFromCookie({ userId: "user-2", workspaceId: uuidv7(), originChecked: true, csrfChecked: true });
    expect(await revokePat(db, other, m.id, NOW)).toBe(false);
    expect(await verifyPat(db, m.token, NOW)).not.toBeNull();
    const list = await listPats(db, session.workspaceId);
    const item = list.find((p) => p.id === m.id)!;
    expect(item.display).toBe(`mkt_pat_${m.prefix}_…`);
    expect(JSON.stringify(list)).not.toContain(m.token);
  });

  it("needs a name and a known scope", async () => {
    await expect(mintPat(db, session, { name: "  ", scopes: ["read"] }, NOW)).rejects.toThrow(/name/);
    await expect(mintPat(db, session, { name: "x", scopes: [] }, NOW)).rejects.toThrow(/at least one/);
    await expect(mintPat(db, session, { name: "x", scopes: ["read"], expiresAt: NOW }, NOW)).rejects.toThrow(/future/);
  });
});
