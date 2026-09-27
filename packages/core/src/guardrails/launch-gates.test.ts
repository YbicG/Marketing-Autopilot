// §8 "Launch-day gates" (D20): on the launch plan's launch day, no post goes out until the tracking
// test, prices-visible, no-signup-wall and landing-page checks have passed, and every pre-publish
// warning becomes a block. Other days are unaffected.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { checkTrackingTest, createLandingAudit, finishLandingAudit, startTrackingTest } from "../launch/plan/gates.ts";
import { goodSnapshot, signupWallSnapshot } from "../launch/plan/test-fixtures.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { launchDayVerdict } from "../publishing/launch-gates.ts";
import { approvedPost, LOCAL_DAY, postRow, seedLaunchPlan, world, type World } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const gate = { key: "gate.tracking_test", title: "Tracking", status: "todo", passed: false };

/** Passes every gate the way the app does: the tracking link gets a visit, the landing audit passes. */
async function passAllGates(w: World) {
  const { utmContent } = await startTrackingTest(db, w.s.workspaceId, w.s.productId, { now: w.clock.now });
  const aggregate = { rows: async () => [{ utm_content: utmContent, visits: 1 }] };
  expect((await checkTrackingTest({ db, aggregateFor: async () => aggregate, now: () => w.clock.now }, w.s.workspaceId, w.s.productId)).passed).toBe(true);
  const audit = await createLandingAudit(db, w.s.workspaceId, w.s.productId);
  expect((await finishLandingAudit(db, w.s.workspaceId, audit.auditId, { snapshot: goodSnapshot() })).passed).toBe(true);
}

describe("§8 Launch-day gates", () => {
  it("only the launch day is affected", () => {
    expect(launchDayVerdict({ localDate: "2026-10-19", launch: { launchDate: LOCAL_DAY, open: [gate] }, warnings: ["x"] })).toEqual({ launchDay: false, block: null });
    expect(launchDayVerdict({ localDate: LOCAL_DAY, launch: null, warnings: ["x"] })).toEqual({ launchDay: false, block: null });
    expect(launchDayVerdict({ localDate: LOCAL_DAY, launch: { launchDate: LOCAL_DAY, open: [gate] }, warnings: [] }).block).toMatch(/tracking test link hasn't been opened/);
    expect(launchDayVerdict({ localDate: LOCAL_DAY, launch: { launchDate: LOCAL_DAY, open: [] }, warnings: ["Typed link."] }).block).toMatch(/^On launch day every check has to pass/);
  });

  it("publish time: an open gate holds a launch-day post", async () => {
    const w = await world(db);
    await seedLaunchPlan(db, w.s, LOCAL_DAY);
    const id = await approvedPost(w);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toMatch(/^Launch-day checks aren't done yet: /);
  });

  it("publish time: the same open gates don't touch the day before", async () => {
    const w = await world(db);
    await seedLaunchPlan(db, w.s, "2026-10-21");
    const id = await approvedPost(w);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("submitted");
  });

  it("once the tracking test and landing audit pass, the launch-day post goes out; a signup wall reopens a gate", async () => {
    const w = await world(db);
    const planId = await seedLaunchPlan(db, w.s, LOCAL_DAY);
    await passAllGates(w);
    const id = await approvedPost(w);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("submitted");

    const walled = await createLandingAudit(db, w.s.workspaceId, w.s.productId);
    expect((await finishLandingAudit(db, w.s.workspaceId, walled.auditId, { snapshot: signupWallSnapshot() })).passed).toBe(false);
    const [row] = await db.select().from(schema.launchTasks).where(and(eq(schema.launchTasks.launchPlanId, planId), eq(schema.launchTasks.key, "gate.no_signup_wall")));
    expect(row!.status).not.toBe("done");
    const next = await approvedPost(w, {}, new Date("2026-10-21T00:30:00Z")); // 8:30 pm, still Oct 20 locally
    expect(await handlePublishDue(w.deps, { postId: next, generation: 1 })).toBe("failed");
    expect((await postRow(db, next)).lastError).toMatch(/can see your landing page without signing in/);
  });

  it("publish time: on launch day a warning (a typed web address) becomes a block", async () => {
    const w = await world(db);
    await seedLaunchPlan(db, w.s, LOCAL_DAY);
    await passAllGates(w);
    const [v] = await db.select().from(schema.variants).where(eq(schema.variants.id, w.s.variantId));
    const body = v!.body as { variant: { text: string } };
    await db
      .update(schema.variants)
      .set({ body: { ...body, variant: { ...body.variant, text: "Your syllabus, now a calendar. More at https://syllacal.com/faq" } } })
      .where(eq(schema.variants.id, w.s.variantId));
    const id = await approvedPost(w);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toMatch(/^On launch day every check has to pass before a post goes out\./);
  });
});
