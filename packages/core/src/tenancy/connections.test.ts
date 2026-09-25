import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { listConnections, listProducts, syncConnections, updateConnectionLimits } from "./connections.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function fixture() {
  const ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  const productId = uuidv7();
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal" });
  return { ws, productId };
}

const now = new Date("2026-10-20T12:00:00Z");

describe("syncConnections", () => {
  it("inserts accounts, marks personal platforms shared, and keeps the user's limits on re-sync", async () => {
    const { ws, productId } = await fixture();
    const r = await syncConnections(db, ws, {
      productId,
      publisher: "upload_post",
      profileRef: "syllacal",
      now,
      health: [
        { platform: "tiktok", handle: "@syllacal", status: "active", tokenExpiresAt: "2026-12-01T00:00:00Z" },
        { platform: "x", handle: "@cj", status: "active" },
        { platform: "instagram", status: "active", tokenExpiresAt: "2026-10-01T00:00:00Z" },
      ],
    });
    expect(r).toEqual({ upserted: 3, missing: 0 });
    expect((await listProducts(db, ws)).map((p) => p.slug)).toEqual(["syllacal"]);

    let rows = await listConnections(db, ws);
    const by = (p: string) => rows.find((c) => c.platform === p)!;
    expect(by("x").shared).toBe(true);
    expect(by("tiktok")).toMatchObject({ shared: false, status: "active", handle: "@syllacal", productName: "SyllaCal", maxPerDay: 2 });
    expect(by("instagram").status).toBe("reauth_required"); // token already expired

    expect(await updateConnectionLimits(db, ws, by("tiktok").id, { maxPerDay: 1 })).toBe(true);
    await expect(updateConnectionLimits(db, ws, by("tiktok").id, { maxPerDay: 4 })).rejects.toThrow();
    const stranger = await fixture();
    expect(await updateConnectionLimits(db, stranger.ws, by("tiktok").id, { maxPerDay: 3 })).toBe(false);

    const again = await syncConnections(db, ws, {
      productId,
      publisher: "upload_post",
      profileRef: "syllacal",
      now,
      health: [{ platform: "tiktok", status: "active" }, { platform: "instagram", status: "active" }],
    });
    expect(again).toEqual({ upserted: 2, missing: 1 });
    rows = await listConnections(db, ws);
    expect(rows).toHaveLength(3);
    expect(by("tiktok")).toMatchObject({ maxPerDay: 1, handle: "@syllacal", status: "active" });
    expect(by("instagram").status).toBe("active");
    expect(by("x").status).toBe("reauth_required");
    expect(await listConnections(db, stranger.ws)).toEqual([]);
  });

  it("refuses a product from another workspace", async () => {
    const a = await fixture();
    const b = await fixture();
    await expect(syncConnections(db, a.ws, { productId: b.productId, publisher: "upload_post", profileRef: "p", health: [] })).rejects.toThrow();
  });
});
