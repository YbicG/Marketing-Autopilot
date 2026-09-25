import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { memoryAnalyticsGateway } from "../publishing/scheduler.ts";
import { addPost, fakeAdapter, seedWorkspace } from "../publishing/test-fixtures.ts";
import { pullConversions } from "./conversions.ts";
import { normalizeMetrics, pullPostMetrics } from "./metrics.ts";
import { rankAngles, resultsByAngle, rewardSnapshot, signupSignal, type AngleAgg } from "./results.ts";
import { analyticsJobsFor, ensureAnalyticsWindows } from "./windows.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const PUB = new Date("2026-10-20T12:00:00Z");

describe("windows", () => {
  it("schedules +24h, +72h, +7d with idempotent job ids", async () => {
    const jobs = analyticsJobsFor("p1", PUB);
    expect(jobs.map((j) => [j.jobId, j.runAt.toISOString()])).toEqual([
      ["an_p1_h24", "2026-10-21T12:00:00.000Z"],
      ["an_p1_h72", "2026-10-23T12:00:00.000Z"],
      ["an_p1_d7", "2026-10-27T12:00:00.000Z"],
    ]);
    const gw = memoryAnalyticsGateway();
    expect(await ensureAnalyticsWindows(gw, "p1", PUB)).toBe(3);
    expect(await ensureAnalyticsWindows(gw, "p1", PUB)).toBe(0);
    expect(gw.jobs.size).toBe(3);
  });
});

describe("metrics", () => {
  it("a 0 from an aggregator is unknown, not zero", () => {
    const r = normalizeMetrics({
      views: 120,
      likes: 0,
      comments: null,
      shares: 3,
      saves: 0,
      profileVisits: null,
      follows: null,
      linkClicks: 4,
      engagedViews: null,
      unknown: ["shares"],
    });
    expect(r.metrics).toMatchObject({ views: 120, likes: null, shares: null, linkClicks: 4 });
    expect(r.unknown).toEqual(expect.arrayContaining(["likes", "saves", "shares", "comments"]));
    expect(normalizeMetrics(null).unknown).toHaveLength(9);
  });

  it("pullPostMetrics stores age_hours and maturity per window", async () => {
    const s = await seedWorkspace(db);
    const id = await addPost(db, s, PUB, { state: "published", publishedAt: PUB, providerPostId: "tp1" });
    const adapter = fakeAdapter();
    adapter.onMetrics = async () => ({
      views: 50,
      likes: 2,
      comments: 0,
      shares: 0,
      saves: 0,
      profileVisits: 1,
      follows: 0,
      linkClicks: 2,
      engagedViews: null,
      unknown: [],
    });
    const deps = { db, ctxFor: () => ({ secret: async () => null }), adapterFor: () => adapter };
    // The 72 h pull ran early (at 70 h): stored but not mature.
    await pullPostMetrics({ ...deps, now: () => new Date(PUB.getTime() + 70 * 3_600_000) }, { postId: id, window: "h72" });
    let [snap] = await db.select().from(schema.analyticsSnapshots).where(eq(schema.analyticsSnapshots.postId, id));
    expect(snap).toMatchObject({ window: "h72", ageHours: 70, mature: false });
    await pullPostMetrics({ ...deps, now: () => new Date(PUB.getTime() + 73 * 3_600_000) }, { postId: id, window: "h72" });
    [snap] = await db.select().from(schema.analyticsSnapshots).where(eq(schema.analyticsSnapshots.postId, id));
    expect(snap).toMatchObject({ ageHours: 73, mature: true, source: "upload_post" });
    expect(snap!.metrics.comments).toBeNull();
  });
});

describe("Results v0 ranking", () => {
  const m = (views: number, linkClicks: number, extra: Record<string, number | null> = {}) => ({
    platform: "threads",
    metrics: { views, linkClicks, profileVisits: null, follows: null, ...extra },
  });
  const agg = (angleId: string, mature: ReturnType<typeof m>[], conv: { visits: number; signups: number } | null): AngleAgg => ({
    angleId,
    title: angleId,
    status: "active",
    posts: mature.length,
    mature,
    conv,
  });

  it("ranks only angles with ≥3 mature posts", () => {
    const rows = rankAngles([
      agg("two", [m(9999, 999), m(9999, 999)], { visits: 100, signups: 50 }),
      agg("three", [m(100, 5), m(100, 5), m(100, 5)], { visits: 10, signups: 1 }),
    ]);
    const two = rows.find((r) => r.angleId === "two")!;
    const three = rows.find((r) => r.angleId === "three")!;
    expect(two).toMatchObject({ rank: null, winner: false });
    expect(two.note).toMatch(/1 more post/);
    expect(three).toMatchObject({ rank: 1, winner: true, canTurnIntoAd: true, linkTapPct: 5 });
  });

  it("signups rank above intent, intent above views; winner needs a non-negative signup signal", () => {
    const rows = rankAngles([
      agg("views", [m(10000, 1), m(10000, 1), m(10000, 1)], { visits: 30, signups: 0 }),
      agg("taps", [m(100, 20), m(100, 20), m(100, 20)], { visits: 30, signups: 0 }),
    ]);
    expect(rows.map((r) => r.angleId)).toEqual(["taps", "views"]);
    // 30 visits and no signups is a negative signal: no winner, no "Turn into an ad".
    expect(rows[0]).toMatchObject({ rank: 1, signupSignal: "negative", winner: false, canTurnIntoAd: false });

    const withSignups = rankAngles([
      agg("taps", [m(100, 20), m(100, 20), m(100, 20)], { visits: 30, signups: 0 }),
      agg("signups", [m(50, 1), m(50, 1), m(50, 1)], { visits: 5, signups: 2 }),
    ]);
    expect(withSignups[0]).toMatchObject({ angleId: "signups", winner: true });

    const noData = rankAngles([agg("a", [m(100, 20), m(100, 20), m(100, 20)], null)]);
    expect(noData[0]).toMatchObject({ rank: 1, signupSignal: "none", winner: false });
  });

  it("reward is read from the mature snapshot closest to 72 h", () => {
    const s = rewardSnapshot([
      { ageHours: 24, mature: true, id: "a" },
      { ageHours: 70, mature: false, id: "b" },
      { ageHours: 168, mature: true, id: "c" },
      { ageHours: 75, mature: true, id: "d" },
    ]);
    expect(s!.id).toBe("d");
    expect(rewardSnapshot([{ ageHours: 10, mature: false }])).toBeNull();
    expect(signupSignal({ visits: 5, signups: 0 })).toBe("neutral");
  });

  it("resultsByAngle reads snapshots and conversions from the DB", async () => {
    const s = await seedWorkspace(db);
    for (let i = 0; i < 3; i++) {
      const id = await addPost(db, s, PUB, { state: "published", publishedAt: PUB });
      await db.insert(schema.analyticsSnapshots).values({
        id: uuidv7(),
        workspaceId: s.workspaceId,
        postId: id,
        window: "h72",
        ageHours: 72,
        mature: true,
        metrics: { views: 200, linkClicks: 10, profileVisits: 3 },
        source: "upload_post",
      });
    }
    const client = { daily: async () => [{ day: "2026-10-21", utmSource: "threads", utmTerm: s.angleId, visits: 12, signups: 2, purchases: 0 }] };
    const pulled = await pullConversions({ db, clientFor: (p) => (p.id === s.productId ? client : null), now: () => new Date("2026-10-22T00:00:00Z") }, { workspaceId: s.workspaceId });
    expect(pulled).toEqual({ products: 1, rows: 1 });
    // Pulling again upserts rather than duplicating.
    await pullConversions({ db, clientFor: (p) => (p.id === s.productId ? client : null) }, { workspaceId: s.workspaceId });

    const r = await resultsByAngle(db, s.workspaceId, s.productId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      title: "Syllabus to calendar",
      posts: 3,
      maturePosts: 3,
      views: 600,
      linkTapPct: 5,
      profileVisits: 9,
      visits: 12,
      signups: 2,
      rank: 1,
      winner: true,
    });
  });
});
