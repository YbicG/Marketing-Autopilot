import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { LAUNCH_GATE_KEYS } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { addPost, seedWorkspace, type Seeded } from "../../publishing/test-fixtures.ts";
import { checkTrackingTest, createLandingAudit, finishLandingAudit, firstPartyAggregateFor, startLandingAudit, startTrackingTest, type TrackingAggregateClient } from "./gates.ts";
import { createLaunchPlan, launchDayView, launchGateStatus, launchView, refreshLaunchPlan, setTaskStatus, toggleOptionalTask } from "./plan.ts";
import { LaunchPlanError } from "./schedule.ts";
import { launchTick } from "./tick.ts";
import { LAUNCH_TEMPLATE_LC_V1 } from "./template.ts";
import { goodSnapshot, pricingOneClickSnapshot, signupWallSnapshot } from "./test-fixtures.ts";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const USER = "user-1";
const DEC_14 = new Date("2026-12-14T15:00:00Z");
const LAUNCH_NOON = new Date("2027-01-19T17:00:00Z"); // noon in New York

async function seedSyllaCal(): Promise<Seeded> {
  const s = await seedWorkspace(db);
  await db.update(schema.campaigns).set({ startDate: "2027-01-06", launchDate: "2027-01-19" }).where(eq(schema.campaigns.id, s.campaignId));
  return s;
}

async function tasks(planId: string) {
  const rows = await db.select().from(schema.launchTasks).where(eq(schema.launchTasks.launchPlanId, planId));
  return new Map(rows.map((r) => [r.key, r]));
}

const fakeAggregate = (rows: { utm_content: string; visits: number }[]) => {
  const calls: [string, string][] = [];
  const client: TrackingAggregateClient = {
    rows: async (from, to) => {
      calls.push([from, to]);
      return rows;
    },
  };
  return { client, calls };
};

async function passLandingGates(s: Seeded, snapshot = goodSnapshot()) {
  const { auditId } = await createLandingAudit(db, s.workspaceId, s.productId);
  await startLandingAudit(db, auditId);
  return finishLandingAudit(db, s.workspaceId, auditId, { snapshot }, DEC_14);
}

async function passTrackingGate(s: Seeded) {
  const { utmContent } = await startTrackingTest(db, s.workspaceId, s.productId, { now: DEC_14, nonce: "n1" });
  const { client } = fakeAggregate([{ utm_content: utmContent, visits: 1 }]);
  return checkTrackingTest({ db, aggregateFor: async () => client, now: () => DEC_14 }, s.workspaceId, s.productId);
}

describe("createLaunchPlan", () => {
  it("creates one active plan with every template task, dated in the workspace zone", async () => {
    const s = await seedSyllaCal();
    const r = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14, userId: USER });
    expect(r.created).toBe(true);
    expect(r.overdue).toContain("book.subreddit_mods");
    expect(r.overdue).not.toContain("send.press_pitches");
    const [plan] = await db.select().from(schema.launchPlans).where(eq(schema.launchPlans.id, r.planId));
    expect(plan).toMatchObject({ status: "active", startDate: "2027-01-06", launchDate: "2027-01-19", templateVersion: "lc-v1", productId: s.productId });
    const t = await tasks(r.planId);
    expect(t.size).toBe(LAUNCH_TEMPLATE_LC_V1.tasks.length);
    expect(t.get("book.subreddit_mods")!.dueDate).toBe("2026-12-01");
    expect(t.get("send.press_pitches")!.dueDate).toBe("2026-12-15");
    expect(t.get("send.ambassadors")!.dueDate).toBe("2026-12-18");
    expect(t.get("content.d01_d07")).toMatchObject({ dueDate: "2027-01-03", dayOffset: -16 });
    expect(t.get("content.d01_d07")!.ref).toMatchObject({ kind: "content_range", campaignId: s.campaignId, fromDay: "1", toDay: "7" });
    expect(t.get("book.betalist")!.status).toBe("skipped");
    expect(t.get("book.subreddit_mods")!.status).toBe("ready");
    const logs = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.workspaceId, s.workspaceId), eq(schema.auditLog.action, "launch.plan.created")));
    expect(logs).toHaveLength(1);
  });

  it("is idempotent per campaign and re-dates open tasks when the launch day moves", async () => {
    const s = await seedSyllaCal();
    const first = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const again = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    expect(again).toMatchObject({ planId: first.planId, created: false, redated: false, added: [] });
    expect((await tasks(first.planId)).size).toBe(LAUNCH_TEMPLATE_LC_V1.tasks.length);

    const before = await tasks(first.planId);
    await setTaskStatus(db, s.workspaceId, before.get("book.subreddit_mods")!.id, "done", USER, DEC_14);
    await db.update(schema.campaigns).set({ startDate: "2027-01-13", launchDate: "2027-01-26" }).where(eq(schema.campaigns.id, s.campaignId));
    const moved = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14, optionalOn: ["book.producthunt"] });
    expect(moved).toMatchObject({ planId: first.planId, created: false, redated: true });
    const after = await tasks(first.planId);
    expect(after.get("book.subreddit_mods")).toMatchObject({ status: "done", dueDate: "2026-12-01" }); // done keeps its date
    expect(after.get("send.press_pitches")!.dueDate).toBe("2026-12-22");
    expect(after.get("content.d01_d07")!.dueDate).toBe("2027-01-10");
    expect(after.get("book.producthunt")!.status).not.toBe("skipped");
    expect(after.get("book.uneed")!.status).toBe("skipped");
    const [plan] = await db.select().from(schema.launchPlans).where(eq(schema.launchPlans.id, first.planId));
    expect(plan!.launchDate).toBe("2027-01-26");
  });

  it("keeps one active plan per product", async () => {
    const s = await seedSyllaCal();
    const a = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, s.campaignId));
    const campaign2 = uuidv7();
    await db.insert(schema.campaigns).values({ ...c!, id: campaign2, startDate: "2027-08-18", launchDate: "2027-08-31" });
    const b = await createLaunchPlan(db, s.workspaceId, { campaignId: campaign2, now: DEC_14 });
    expect(b.planId).not.toBe(a.planId);
    const plans = await db.select().from(schema.launchPlans).where(eq(schema.launchPlans.productId, s.productId));
    expect(plans.filter((p) => p.status === "active").map((p) => p.id)).toEqual([b.planId]);
    expect((await launchView(db, s.workspaceId, s.productId, DEC_14))!.plan.id).toBe(b.planId);
  });

  it("refuses another workspace's campaign", async () => {
    const s = await seedSyllaCal();
    const other = await seedWorkspace(db);
    await expect(createLaunchPlan(db, other.workspaceId, { campaignId: s.campaignId })).rejects.toThrow(LaunchPlanError);
  });
});

describe("task actions", () => {
  it("refuses to pass a gate by hand, and blocks gate dependents until the gates pass", async () => {
    const s = await seedSyllaCal();
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const t = await tasks(planId);
    for (const status of ["done", "skipped", "todo"] as const) {
      await expect(setTaskStatus(db, s.workspaceId, t.get("gate.tracking_test")!.id, status, USER)).rejects.toMatchObject({ code: "gate_manual" });
    }
    await expect(setTaskStatus(db, s.workspaceId, t.get("launch.subreddit_posts")!.id, "done", USER)).rejects.toMatchObject({ code: "blocked" });
    expect((await launchGateStatus(db, s.workspaceId, s.productId)).allPassed).toBe(false);

    await passTrackingGate(s);
    await passLandingGates(s);
    const gates = await launchGateStatus(db, s.workspaceId, s.productId);
    expect(gates.allPassed).toBe(true);
    expect(gates.gates.map((g) => g.key).sort()).toEqual([...LAUNCH_GATE_KEYS].sort());
    // B4's contract: passed ⇔ status done on the gate rows.
    const rows = await tasks(planId);
    for (const k of LAUNCH_GATE_KEYS) expect(rows.get(k)).toMatchObject({ status: "done", gate: { passed: true } });

    expect(await setTaskStatus(db, s.workspaceId, t.get("launch.subreddit_posts")!.id, "done", USER)).toBe("done");
    const logs = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.workspaceId, s.workspaceId), eq(schema.auditLog.action, "launch.task.status")));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorType: "user", actorId: USER });
  });

  it("ticks, reopens and skips plain tasks; dependents follow", async () => {
    const s = await seedSyllaCal();
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const t = await tasks(planId);
    expect(t.get("send.press_pitches")!.status).toBe("todo"); // waits on kit.press
    // Auto rows follow the work behind them; a person can't tick them.
    await expect(setTaskStatus(db, s.workspaceId, t.get("kit.press")!.id, "done", USER, DEC_14)).rejects.toMatchObject({ code: "auto_manual" });
    const kitId = uuidv7();
    await db.insert(schema.launchKits).values({ id: kitId, workspaceId: s.workspaceId, productId: s.productId, launchPlanId: planId, kind: "press", status: "ready" });
    await refreshLaunchPlan(db, s.workspaceId, planId, DEC_14);
    const after = await tasks(planId);
    expect(after.get("kit.press")!.status).toBe("done");
    expect(after.get("send.press_pitches")!.status).toBe("ready");
    await setTaskStatus(db, s.workspaceId, after.get("send.press_pitches")!.id, "done", USER, DEC_14);
    expect((await tasks(planId)).get("send.press_pitches")!.status).toBe("done");
    await setTaskStatus(db, s.workspaceId, after.get("send.press_pitches")!.id, "todo", USER, DEC_14);
    expect((await tasks(planId)).get("send.press_pitches")).toMatchObject({ status: "ready", doneAt: null });
    expect(await setTaskStatus(db, s.workspaceId, t.get("book.subreddit_mods")!.id, "skipped", USER, DEC_14)).toBe("skipped");
  });

  it("turns optional tasks on and off, and only optional ones", async () => {
    const s = await seedSyllaCal();
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const t = await tasks(planId);
    expect(await toggleOptionalTask(db, s.workspaceId, t.get("book.uneed")!.id, true, USER, DEC_14)).toBe("ready");
    expect(await toggleOptionalTask(db, s.workspaceId, t.get("book.uneed")!.id, false, USER, DEC_14)).toBe("skipped");
    await expect(toggleOptionalTask(db, s.workspaceId, t.get("send.press_pitches")!.id, false, USER)).rejects.toMatchObject({ code: "not_optional" });
  });
});

describe("content tasks and the D1–D19 approval count", () => {
  it("scheduled once every post in the range is approved; counted in the view", async () => {
    const s = await seedSyllaCal();
    await db.update(schema.contentItems).set({ day: 3, status: "ready" }).where(eq(schema.contentItems.id, s.contentItemId));
    // An unfilled open slot doesn't count.
    await db.insert(schema.contentItems).values({ id: uuidv7(), workspaceId: s.workspaceId, campaignId: s.campaignId, deliverableKey: "open:1", kind: "post", slotKind: "open", day: 4 });
    const postId = await addPost(db, s, new Date("2027-01-08T23:30:00Z"));
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    expect((await tasks(planId)).get("content.d01_d07")!.status).toBe("ready");
    let view = (await launchView(db, s.workspaceId, s.productId, DEC_14))!;
    expect(view.autoApproval).toMatchObject({ approved: 0, total: 1, dueDate: "2027-01-03", onTrack: false });
    expect(view.groups.flatMap((g) => g.tasks).find((x) => x.key === "content.d01_d07")!.reasons).toEqual(["0 of 1 approved."]);

    await db.update(schema.posts).set({ state: "queued" }).where(eq(schema.posts.id, postId));
    await refreshLaunchPlan(db, s.workspaceId, planId, DEC_14);
    expect((await tasks(planId)).get("content.d01_d07")!.status).toBe("scheduled");
    view = (await launchView(db, s.workspaceId, s.productId, DEC_14))!;
    expect(view.autoApproval).toMatchObject({ approved: 1, total: 1, pct: 100, onTrack: true });

    await db.update(schema.posts).set({ state: "published", publishedAt: new Date("2027-01-08T23:31:00Z") }).where(eq(schema.posts.id, postId));
    await refreshLaunchPlan(db, s.workspaceId, planId, DEC_14);
    expect((await tasks(planId)).get("content.d01_d07")).toMatchObject({ status: "done", doneBy: "app" });
  });
});

describe("tracking test gate", () => {
  it("makes a tracked test link and passes on the first visit", async () => {
    const s = await seedSyllaCal();
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const started = await startTrackingTest(db, s.workspaceId, s.productId, { now: DEC_14, nonce: "abc" });
    expect(started.utmContent).toBe("mkt-test-abc");
    const u = new URL(started.url);
    expect(u.origin).toBe("https://syllacal.com");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ utm_source: "test", utm_medium: "organic", utm_content: "mkt-test-abc" });
    const links = await db.select().from(schema.trackedLinks).where(eq(schema.trackedLinks.productId, s.productId));
    expect(links.map((l) => l.url)).toContain(started.url);
    expect((await tasks(planId)).get("gate.tracking_test")!.ref).toMatchObject({ testUrl: started.url, utmContent: "mkt-test-abc" });

    const none = fakeAggregate([{ utm_content: "someone-else", visits: 5 }]);
    const r1 = await checkTrackingTest({ db, aggregateFor: async () => none.client, now: () => DEC_14 }, s.workspaceId, s.productId);
    expect(r1.passed).toBe(false);
    expect(r1.reasons[0]).toContain("No visit from the test link yet");
    expect(none.calls[0]).toEqual(["2026-12-13", "2026-12-14"]);
    expect((await tasks(planId)).get("gate.tracking_test")!.status).not.toBe("done");

    const hit = fakeAggregate([{ utm_content: "mkt-test-abc", visits: 1 }]);
    const r2 = await checkTrackingTest({ db, aggregateFor: async () => hit.client, now: () => DEC_14 }, s.workspaceId, s.productId);
    expect(r2.passed).toBe(true);
    expect((await tasks(planId)).get("gate.tracking_test")).toMatchObject({ status: "done", doneBy: "check", gate: { passed: true } });

    // A passed test isn't reset by a second start.
    const again = await startTrackingTest(db, s.workspaceId, s.productId, { now: DEC_14, nonce: "zzz" });
    expect(again).toMatchObject({ alreadyPassed: true, utmContent: "mkt-test-abc" });
  });

  it("stays open with a plain reason when no tracking numbers are connected", async () => {
    const s = await seedSyllaCal();
    await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    await startTrackingTest(db, s.workspaceId, s.productId, { now: DEC_14 });
    const r = await checkTrackingTest({ db, aggregateFor: firstPartyAggregateFor(db, { env: {} }), now: () => DEC_14 }, s.workspaceId, s.productId);
    expect(r).toMatchObject({ passed: false, reasons: ["Connect your site's tracking numbers first."] });
    const failing = await checkTrackingTest(
      { db, aggregateFor: async () => ({ rows: async () => { throw new Error("401"); } }), now: () => DEC_14 },
      s.workspaceId,
      s.productId,
    );
    expect(failing.reasons[0]).toContain("couldn't reach");
  });

  it("the default aggregate client calls the product's endpoint with the token", async () => {
    const s = await seedSyllaCal();
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, s.productId));
    const seen: string[] = [];
    const client = await firstPartyAggregateFor(db, {
      env: { FIRSTPARTY_ANALYTICS_TOKEN: "tok" },
      fetch: (async (url: string, init: { headers: Record<string, string> }) => {
        seen.push(`${url} ${init.headers.Authorization}`);
        return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as never,
    })(product!);
    expect(await client!.rows("2026-12-13", "2026-12-14")).toEqual([]);
    expect(seen[0]).toBe("https://syllacal.com/api/marketing/aggregate?from=2026-12-13&to=2026-12-14 Bearer tok");
  });
});

describe("landing audit gates", () => {
  it("a sign-in wall fails the page gates; a fixed page passes them; a failed capture leaves them alone", async () => {
    const s = await seedSyllaCal();
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const { auditId, jobId } = await createLandingAudit(db, s.workspaceId, s.productId);
    expect(jobId).toBe(`audit-${auditId}`);
    expect(await startLandingAudit(db, auditId)).toMatchObject({ workspaceId: s.workspaceId, url: "https://syllacal.com/" });
    const bad = await finishLandingAudit(db, s.workspaceId, auditId, { snapshot: signupWallSnapshot() }, DEC_14);
    expect(bad.passed).toBe(false);
    let t = await tasks(planId);
    expect(t.get("gate.no_signup_wall")).toMatchObject({ status: "ready", gate: { passed: false } });
    expect(t.get("gate.no_signup_wall")!.gate!.reasons[0]).toContain("sign-in page");
    expect(t.get("gate.landing_audit")!.gate!.passed).toBe(false);
    expect(t.get("gate.pricing_visible")!.gate!.passed).toBe(false);
    expect(t.get("gate.landing_audit")!.ref).toMatchObject({ auditId });
    // Already finished: the worker won't claim it again.
    expect(await startLandingAudit(db, auditId)).toBeNull();

    const good = await passLandingGates(s, pricingOneClickSnapshot());
    expect(good.passed).toBe(true);
    t = await tasks(planId);
    for (const k of ["gate.no_signup_wall", "gate.pricing_visible", "gate.landing_audit"]) expect(t.get(k)!.status).toBe("done");

    const { auditId: third } = await createLandingAudit(db, s.workspaceId, s.productId);
    await finishLandingAudit(db, s.workspaceId, third, { error: "That website took too long to load." }, DEC_14);
    t = await tasks(planId);
    expect(t.get("gate.landing_audit")!.status).toBe("done");
    const view = (await launchView(db, s.workspaceId, s.productId, DEC_14))!;
    expect(view.latestAudit).toMatchObject({ id: third, status: "failed", error: "That website took too long to load." });
  });

  it("a gate that passed and then fails reopens and blocks its dependents again", async () => {
    const s = await seedSyllaCal();
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    await passLandingGates(s);
    await passLandingGates(s, signupWallSnapshot());
    const t = await tasks(planId);
    expect(t.get("gate.no_signup_wall")).toMatchObject({ status: "ready", doneAt: null });
    const logs = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.workspaceId, s.workspaceId), eq(schema.auditLog.action, "launch.gate.reopened")));
    expect(logs.length).toBeGreaterThan(0);
  });

  it("refuses a non-web address", async () => {
    const s = await seedSyllaCal();
    await expect(createLandingAudit(db, s.workspaceId, s.productId, "ftp://syllacal.com")).rejects.toMatchObject({ code: "bad_url" });
  });
});

describe("views and tick", () => {
  it("groups the checklist by week and lists overdue tasks", async () => {
    const s = await seedSyllaCal();
    await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const v = (await launchView(db, s.workspaceId, s.productId, DEC_14))!;
    expect(v.countdown).toMatchObject({ launchDate: "2027-01-19", today: "2026-12-14", daysToLaunch: 36, isLaunchDay: false });
    const labels = v.groups.map((g) => g.label);
    expect(labels[0]).toBe("10 weeks before");
    expect(labels).toContain("Launch day");
    expect(labels.indexOf("1 week before")).toBeLessThan(labels.indexOf("Launch day"));
    expect(labels.indexOf("Launch day")).toBeLessThan(labels.indexOf("Launch week"));
    expect(v.overdue.map((o) => o.key)).toContain("book.subreddit_mods");
    expect(v.gates.allPassed).toBe(false);
    const gate = v.groups.flatMap((g) => g.tasks).find((x) => x.key === "gate.tracking_test")!;
    expect(gate).toMatchObject({ modeLabel: "Gate", canTick: false, dayLabel: "3 days before launch" });
    expect(v.counts.total).toBe(LAUNCH_TEMPLATE_LC_V1.tasks.length);
  });

  it("launch day: today's tasks, posts still to go, live posts with links, numbers", async () => {
    const s = await seedSyllaCal();
    await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    await addPost(db, s, new Date("2027-01-19T23:30:00Z"), { state: "queued" });
    const live = await addPost(db, s, new Date("2027-01-19T14:00:00Z"), {
      state: "published",
      publishedAt: new Date("2027-01-19T14:01:00Z"),
      platformUrl: "https://www.threads.net/@syllacal/post/1",
    });
    await db.insert(schema.analyticsSnapshots).values({ id: uuidv7(), workspaceId: s.workspaceId, postId: live, window: "h24", ageHours: 3, mature: false, metrics: { views: 120, comments: 4 }, source: "test" });
    for (const [utmContent, visits, signups] of [["a", 10, 1], ["b", 5, 2]] as const) {
      await db.insert(schema.conversionSnapshots).values({ id: uuidv7(), workspaceId: s.workspaceId, productId: s.productId, day: "2027-01-19", utmContent, visits, signups });
    }
    const d = (await launchDayView(db, s.workspaceId, s.productId, LAUNCH_NOON))!;
    expect(d.countdown.isLaunchDay).toBe(true);
    expect(d.todayTasks.map((t) => t.key)).toEqual(expect.arrayContaining(["launch.subreddit_posts", "launch.watch_comments", "email.send"]));
    expect(d.nextPostsToday).toHaveLength(1);
    expect(d.publishedToday[0]).toMatchObject({ postId: live, platformUrl: "https://www.threads.net/@syllacal/post/1" });
    expect(d.today).toMatchObject({ postsPublished: 1, views: 120, comments: 4, visits: 15, signups: 3 });
    expect(d.yesterday).toMatchObject({ postsPublished: 0, visits: null, signups: null });
    expect(d.replyBank).toBeNull();
  });

  it("launch.tick re-checks an open tracking test and advances tasks", async () => {
    const s = await seedSyllaCal();
    const { planId } = await createLaunchPlan(db, s.workspaceId, { campaignId: s.campaignId, now: DEC_14 });
    const { utmContent } = await startTrackingTest(db, s.workspaceId, s.productId, { now: DEC_14 });
    const hit = fakeAggregate([{ utm_content: utmContent, visits: 2 }]);
    const r = await launchTick({ db, aggregateFor: async (p) => (p.id === s.productId ? hit.client : null), now: () => DEC_14 });
    expect(r.errors).toEqual([]);
    expect(r.trackingChecks).toBeGreaterThanOrEqual(1);
    expect((await tasks(planId)).get("gate.tracking_test")!.status).toBe("done");
  });
});
