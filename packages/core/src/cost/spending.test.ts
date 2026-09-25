import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { ensurePeriods, periodMonth, release, reserve, settle } from "./ledger.ts";
import { ledgerEntries, monthRange, spendBreakdown } from "./spending.ts";
import { formatMonthlyRange, isConnected, purposeEnvName, subscriptionSummary, CAPABILITIES } from "./subscriptions.ts";

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
  const runId = uuidv7();
  await db.insert(schema.generationRuns).values({ id: runId, workspaceId: ws, productId, kind: "package", status: "running", input: {}, capMicros: 12_000_000 });
  const [pid] = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 60_000_000 }]);
  return { ws, productId, runId, pid: pid! };
}

describe("monthRange", () => {
  it("spans one calendar month in UTC and rejects junk", () => {
    const r = monthRange("2026-12");
    expect(r.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(() => monthRange("december")).toThrow();
  });
});

describe("spendBreakdown + ledgerEntries", () => {
  it("counts settled actuals and in-flight reservations, grouped by project, provider and feature", async () => {
    const { ws, runId, pid } = await fixture();
    const base = { workspaceId: ws, budgetPeriodIds: [pid] };
    const a = await reserve(db, { ...base, estMicros: 100_000, feature: "copy.post", provider: "anthropic", runId, requestedModel: "claude-sonnet-5" });
    await settle(db, a, { actualMicros: 80_000, servedModel: "claude-sonnet-5" });
    await reserve(db, { ...base, estMicros: 50_000, feature: "tts.vo", provider: "elevenlabs", runId });
    const c = await reserve(db, { ...base, estMicros: 30_000, feature: "copy.post", provider: "anthropic" });
    await release(db, c, "boom");

    // Another workspace's spend never shows up.
    const other = await fixture();
    await reserve(db, { workspaceId: other.ws, budgetPeriodIds: [other.pid], estMicros: 999_000, feature: "x", provider: "anthropic" });

    const b = await spendBreakdown(db, ws, periodMonth());
    expect(b.totalMicros).toBe(130_000);
    expect(b.inFlightMicros).toBe(50_000);
    expect(b.byProvider.map((g) => [g.key, g.micros, g.calls])).toEqual([
      ["anthropic", 80_000, 2],
      ["elevenlabs", 50_000, 1],
    ]);
    expect(b.byFeature.find((g) => g.key === "copy.post")?.micros).toBe(80_000);
    expect(b.byProject.map((g) => [g.label, g.slug, g.micros])).toEqual([
      ["SyllaCal", "syllacal", 130_000],
      ["Not tied to a project", null, 0],
    ]);
    expect(b.externalMicros).toBe(0);

    const entries = await ledgerEntries(db, ws);
    expect(entries).toHaveLength(3);
    const settled = entries.find((e) => e.id === a)!;
    expect(settled).toMatchObject({ status: "settled", estMicros: 100_000, actualMicros: 80_000, model: "claude-sonnet-5", runKind: "package", productSlug: "syllacal" });
    expect(entries.find((e) => e.id === c)).toMatchObject({ status: "released", runId: null, error: "boom" });

    expect((await spendBreakdown(db, ws, "2020-01")).totalMicros).toBe(0);
  });
});

describe("subscriptions", () => {
  it("adds up connected monthly services only", () => {
    expect(formatMonthlyRange(subscriptionSummary(new Set()))).toBe("$0/mo");
    const up = new Set(["upload_post.api_key", "upload_post.webhook_secret"]);
    expect(formatMonthlyRange(subscriptionSummary(up))).toBe("$16–24/mo");
    // Half-configured Upload-Post isn't connected; pay-per-use research never adds to the total.
    expect(subscriptionSummary(new Set(["upload_post.api_key", "exa.api_key"])).connected).toHaveLength(0);
    expect(formatMonthlyRange(subscriptionSummary(new Set([...up, "elevenlabs.api_key"])))).toBe("$22–46/mo");
  });

  it("research needs either key; env names follow the worker's rule", () => {
    const research = CAPABILITIES.find((c) => c.id === "research")!;
    expect(isConnected(research, new Set(["brave.api_key"]))).toBe(true);
    expect(purposeEnvName("upload_post.api_key")).toBe("UPLOAD_POST_API_KEY");
    expect(purposeEnvName("github.token")).toBe("GITHUB_TOKEN");
  });
});
