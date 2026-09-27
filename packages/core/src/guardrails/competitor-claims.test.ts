// §8 "Truthful competitor claims": competitor facts are at most 30 days old, expires_at must be on
// or after scheduled_at, and stale.sweep sends approved posts back when a fact goes out of date.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FieldMetaMap, ProductDna } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { claimIssues } from "../engine/validate.ts";
import { buildEvidenceBundle } from "../ingest/evidence.ts";
import { buildClaims } from "../ingest/profile.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { staleSweep } from "../publishing/stale-sweep.ts";
import { approvedPost, postRow, SLOT, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const DAY = 86_400_000;

describe("§8 Truthful competitor claims", () => {
  it("a competitor fact expires 30 days after it was gathered; other facts don't", () => {
    const bundle = buildEvidenceBundle({
      productName: "SyllaCal",
      artifacts: [],
      research: [{ id: "r1", kind: "competitor", text: "Notion templates are free but manual", sourceUrl: "https://example.com" }],
      assets: [],
      answers: [],
    });
    const now = new Date("2026-10-01T00:00:00Z");
    const dna = {
      offer: { proof: [{ kind: "comparison", text: "Notion templates are free but manual", quote: null, sourceIds: ["S1"] }], pricing: { tiers: [] } },
    } as unknown as ProductDna;
    const [c] = buildClaims(dna, {} as FieldMetaMap, bundle, now);
    expect(c!.kind).toBe("comparison");
    expect(c!.expiresAt!.getTime() - now.getTime()).toBe(30 * DAY);
  });

  it("drafts: a fact that expires before the post goes out blocks; on or after is fine", () => {
    const claims = (expiresAt: Date) => new Map([["C1", { ref: "C1", publicOk: true, status: "sourced" as const, expiresAt }]]);
    expect(claimIssues(["C1"], claims(new Date(SLOT.getTime() - 1)), SLOT).map((i) => i.code)).toEqual(["fact_expires"]);
    expect(claimIssues(["C1"], claims(SLOT), SLOT)).toEqual([]);
    expect(claimIssues(["C1"], claims(new Date(SLOT.getTime() + DAY)), SLOT)).toEqual([]);
  });

  it("publish time: a fact that expires before the slot sends the post back", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await db.update(schema.claims).set({ kind: "comparison", expiresAt: new Date(SLOT.getTime() - DAY) }).where(eq(schema.claims.id, w.s.claimId));
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).staleReason).toMatch(/expires before it posts/);
  });

  it("stale.sweep cancels queued posts whose facts went stale, and leaves the rest", async () => {
    const w = await world(db);
    const staleId = await approvedPost(w);
    const fine = await world(db);
    const fineId = await approvedPost(fine);
    await db.update(schema.claims).set({ kind: "comparison", expiresAt: new Date(SLOT.getTime() - DAY) }).where(eq(schema.claims.id, w.s.claimId));

    const r = await staleSweep(w.deps, { workspaceId: w.s.workspaceId });
    expect(r.stale.map((x) => x.postId)).toEqual([staleId]);
    const p = await postRow(db, staleId);
    expect(p.state).toBe("pending_approval");
    expect(p.staleReason).toMatch(/expires before it posts/);
    expect((await postRow(db, fineId)).state).toBe("queued");
  });

  it("stale.sweep catches a claim rejected after approval", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await db.update(schema.claims).set({ status: "rejected" }).where(eq(schema.claims.id, w.s.claimId));
    const r = await staleSweep(w.deps, { productId: w.s.productId });
    expect(r.stale.map((x) => x.postId)).toEqual([id]);
    expect((await postRow(db, id)).staleReason).toMatch(/You rejected a fact/);
  });
});
