import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { projectAssets } from "./library.ts";
import { seedVideoWorld, type VideoWorld } from "./testing.ts";

describe("project asset library", () => {
  let db: Db;
  let close: () => Promise<void>;
  let w: VideoWorld;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    w = await seedVideoWorld(db);
  });
  afterAll(async () => close());

  it("lists the project's assets with tier counts, scoped to the workspace", async () => {
    const lib = await projectAssets(db, w.ws, w.productId);
    expect(lib.assets.map((a) => a.id)).toContain(w.shotId);
    expect(lib.counts.total).toBe(lib.assets.length);
    expect(lib.counts.byTier.A + lib.counts.byTier.B + lib.counts.byTier.C).toBe(lib.counts.total);
    expect(lib.assets[0]).not.toHaveProperty("storageKey");
    const other = await projectAssets(db, uuidv7(), w.productId);
    expect(other.assets).toHaveLength(0);
    expect(other.counts.total).toBe(0);
  });
});
