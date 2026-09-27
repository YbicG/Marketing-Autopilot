import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { approvePosts, uiSessionFromCookie } from "./approvals.ts";
import { handlePublishDue } from "./due.ts";
import { LAUNCH_GATE_KEYS, launchDayVerdict, launchGateMessage, launchGateStatus } from "./launch-gates.ts";
import { scheduleEffects } from "./scheduler.ts";
import { addPost, fakeAdapter, seedWorkspace, testDeps, type Seeded } from "./test-fixtures.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const SLOT = new Date("2026-10-20T23:30:00Z"); // Tue Oct 20, 7:30 pm New York (Wed Oct 21 in UTC)
const LOCAL = "2026-10-20";

const gate = (key: string, status = "todo") => ({ key, title: key, status, passed: status === "done" });

describe("launchDayVerdict (pure)", () => {
  const open = [gate("gate.tracking_test"), gate("gate.pricing_visible")];
  it("blocks on the launch day only while a gate is open", () => {
    const v = launchDayVerdict({ localDate: LOCAL, launch: { launchDate: LOCAL, open }, warnings: [] });
    expect(v.launchDay).toBe(true);
    expect(v.block).toBe(
      "Launch-day checks aren't done yet: the tracking test link hasn't been opened and it isn't confirmed that your prices are easy to find. Finish them on the Launch page.",
    );
    expect(launchDayVerdict({ localDate: "2026-10-19", launch: { launchDate: LOCAL, open }, warnings: ["w"] })).toEqual({ launchDay: false, block: null });
  });
  it("turns warnings into blocks on launch day only", () => {
    const v = launchDayVerdict({ localDate: LOCAL, launch: { launchDate: LOCAL, open: [] }, warnings: ["A link was typed by hand.", "A link was typed by hand."] });
    expect(v.block).toBe("On launch day every check has to pass before a post goes out. A link was typed by hand.");
    expect(launchDayVerdict({ localDate: LOCAL, launch: { launchDate: LOCAL, open: [] }, warnings: [] })).toEqual({ launchDay: true, block: null });
  });
  it("no plan, no gating", () => {
    expect(launchDayVerdict({ localDate: LOCAL, launch: null, warnings: ["w"] })).toEqual({ launchDay: false, block: null });
  });
  it("names an unknown gate by its title", () => {
    expect(launchGateMessage([{ key: "gate.custom", title: "Test the signup email", status: "todo", passed: false }])).toContain('"Test the signup email" isn\'t done');
  });
});

async function seedPlan(s: Seeded, launchDate: string, statuses: Partial<Record<string, string>> = {}, planStatus: "draft" | "active" | "done" = "active") {
  const planId = uuidv7();
  await db.insert(schema.launchPlans).values({
    id: planId,
    workspaceId: s.workspaceId,
    productId: s.productId,
    campaignId: s.campaignId,
    startDate: "2026-10-07",
    launchDate,
    status: planStatus,
    templateVersion: "test",
  });
  for (const key of LAUNCH_GATE_KEYS) {
    await db.insert(schema.launchTasks).values({
      id: uuidv7(),
      workspaceId: s.workspaceId,
      launchPlanId: planId,
      key,
      title: key,
      mode: "gate",
      dayOffset: -1,
      dueDate: launchDate,
      status: (statuses[key] ?? "todo") as "todo",
    });
  }
  // A non-gate task never blocks.
  await db.insert(schema.launchTasks).values({
    id: uuidv7(),
    workspaceId: s.workspaceId,
    launchPlanId: planId,
    key: "kit.press.pitches",
    title: "Press pitches",
    mode: "manual",
    dayOffset: -3,
    dueDate: launchDate,
  });
  return planId;
}

const allDone = Object.fromEntries(LAUNCH_GATE_KEYS.map((k) => [k, "done"]));

async function setup(opts: Parameters<typeof seedWorkspace>[1] = {}) {
  const s = await seedWorkspace(db, opts);
  const adapter = fakeAdapter();
  const clock = { now: new Date(SLOT.getTime() - 86_400_000) };
  const t = testDeps(db, clock, adapter);
  return { s, adapter, clock, ...t };
}

async function queue(t: Awaited<ReturnType<typeof setup>>, at = SLOT, over: Parameters<typeof addPost>[3] = {}) {
  const id = await addPost(db, t.s, at, over);
  const session = uiSessionFromCookie({ userId: "user-1", workspaceId: t.s.workspaceId, originChecked: true, csrfChecked: true });
  const r = await approvePosts(db, session, [id], { now: t.clock.now });
  for (const e of r.effects) await scheduleEffects({ gateway: t.gateway }, e.postId, e.effects);
  t.clock.now = new Date(at.getTime() + 60_000);
  return id;
}

async function getPost(id: string) {
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, id));
  return p!;
}

describe("launchGateStatus", () => {
  it("reads the latest draft/active plan's gates; a done plan doesn't gate", async () => {
    const s = await seedWorkspace(db);
    expect(await launchGateStatus(db, s.workspaceId, s.productId)).toBeNull();
    await seedPlan(s, "2026-10-01", {}, "done");
    expect(await launchGateStatus(db, s.workspaceId, s.productId)).toBeNull();
    const planId = await seedPlan(s, LOCAL, { "gate.tracking_test": "done", "gate.landing_audit": "skipped" });
    const st = (await launchGateStatus(db, s.workspaceId, s.productId))!;
    expect(st.planId).toBe(planId);
    expect(st.launchDate).toBe(LOCAL);
    expect(st.gates).toHaveLength(4);
    // Skipped is still open: only "done" passes.
    expect(st.open.map((g) => g.key).sort()).toEqual(["gate.landing_audit", "gate.no_signup_wall", "gate.pricing_visible"]);
    // Scoped to the workspace.
    const other = await seedWorkspace(db);
    expect(await launchGateStatus(db, other.workspaceId, s.productId)).toBeNull();
  });
});

describe("publish.prepare on launch day (D20)", () => {
  it("an open gate holds a launch-day post (Needs you) with the plain reason", async () => {
    const t = await setup();
    await seedPlan(t.s, LOCAL, { "gate.pricing_visible": "done", "gate.no_signup_wall": "done", "gate.landing_audit": "done" });
    const id = await queue(t);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(t.adapter.submits).toHaveLength(0);
    expect((await getPost(id)).lastError).toBe(
      "Launch-day checks aren't done yet: the tracking test link hasn't been opened. Finish them on the Launch page.",
    );
  });

  it("open gates don't hold a post the day before (local date, not UTC)", async () => {
    const t = await setup();
    // The slot is Oct 21 in UTC but Oct 20 in New York: launch day Oct 21 must not gate it.
    await seedPlan(t.s, "2026-10-21");
    const id = await queue(t);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("submitted");
  });

  it("every gate done → the launch-day post goes out", async () => {
    const t = await setup();
    await seedPlan(t.s, LOCAL, allDone);
    const id = await queue(t);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("submitted");
    expect(t.adapter.submits).toHaveLength(1);
  });

  it("warnings become blocks on launch day only", async () => {
    const t = await setup();
    await seedPlan(t.s, LOCAL, allDone);
    t.adapter.validateIssues = [{ code: "w", message: "The image is a bit small for Threads.", severity: "warn" }];
    const id = await queue(t);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("failed");
    expect((await getPost(id)).lastError).toBe("On launch day every check has to pass before a post goes out. The image is a bit small for Threads.");

    const t2 = await setup();
    await seedPlan(t2.s, "2026-10-21", allDone);
    t2.adapter.validateIssues = [{ code: "w", message: "The image is a bit small for Threads.", severity: "warn" }];
    const id2 = await queue(t2);
    expect(await handlePublishDue(t2.deps, { postId: id2, generation: 1 })).toBe("submitted");
  });

  it("no launch plan: warnings stay warnings", async () => {
    const t = await setup();
    t.adapter.validateIssues = [{ code: "w", message: "The image is a bit small for Threads.", severity: "warn" }];
    const id = await queue(t);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("submitted");
  });
});

describe("publish.prepare X links window (D24)", () => {
  async function xSetup(window: { from: string; until: string } | null) {
    const t = await setup({ platform: "x" });
    if (window) await db.update(schema.products).set({ xLinksFrom: window.from, xLinksUntil: window.until }).where(eq(schema.products.id, t.s.productId));
    const id = await queue(t, SLOT, { platform: "x" });
    return { t, id };
  }

  it("inside the window the link goes out as a tracking link", async () => {
    const { t, id } = await xSetup({ from: "2026-10-18", until: "2026-10-20" });
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("submitted");
    expect(t.adapter.submits[0]!.text).toMatch(/https:\/\/syllacal\.com\/\?utm_source=x/);
  });

  it("outside the window a post that still carries a link is held", async () => {
    const { t, id } = await xSetup({ from: "2026-10-21", until: "2026-10-27" });
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(t.adapter.submits).toHaveLength(0);
    expect((await getPost(id)).lastError).toBe("The X links add-on isn't on for Tue, Oct 20. Remove the link or set the add-on dates in Settings.");
  });

  it("no window: the link becomes link in bio, as before", async () => {
    const { t, id } = await xSetup(null);
    expect(await handlePublishDue(t.deps, { postId: id, generation: 1 })).toBe("submitted");
    expect(t.adapter.submits[0]!.text).toContain("link in bio");
  });
});
