// Test-only helpers shared by the §8 guardrail tests: one seeded product with a post on the real
// publish path (approvePosts → scheduleEffects → handlePublishDue), a fake publisher and a clock.
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { approvePosts, uiSessionFromCookie, type UiSession } from "../publishing/approvals.ts";
import { LAUNCH_GATE_KEYS } from "../publishing/launch-gates.ts";
import { scheduleEffects } from "../publishing/scheduler.ts";
import { addPost, fakeAdapter, seedWorkspace, testDeps, type Seeded } from "../publishing/test-fixtures.ts";

/** Tue Oct 20, 7:30 pm New York (the seeded workspace's timezone). */
export const SLOT = new Date("2026-10-20T23:30:00Z");
export const LOCAL_DAY = "2026-10-20";

export type World = Awaited<ReturnType<typeof world>>;

export async function world(db: Db, opts: Parameters<typeof seedWorkspace>[1] = {}) {
  const s = await seedWorkspace(db, opts);
  const adapter = fakeAdapter();
  const clock = { now: new Date(SLOT.getTime() - 86_400_000) };
  return { db, s, adapter, clock, ...testDeps(db, clock, adapter) };
}

export function sessionFor(s: Seeded, userId = "user-1"): UiSession {
  return uiSessionFromCookie({ userId, workspaceId: s.workspaceId, originChecked: true, csrfChecked: true });
}

/** Adds a post, approves it through a UI session, schedules its job and moves the clock to the slot. */
export async function approvedPost(w: World, over: Parameters<typeof addPost>[3] = {}, at = SLOT): Promise<string> {
  const id = await addPost(w.db, w.s, at, over);
  const r = await approvePosts(w.db, sessionFor(w.s), [id], { now: w.clock.now });
  if (r.approved.length !== 1) throw new Error(`not approved: ${r.skipped.map((x) => x.reason).join("; ")}`);
  for (const e of r.effects) await scheduleEffects({ gateway: w.gateway }, e.postId, e.effects);
  w.clock.now = new Date(at.getTime() + 60_000);
  return id;
}

export async function postRow(db: Db, id: string) {
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, id));
  return p!;
}

/** A launch plan on `launchDate` with the four D20 gate tasks. */
export async function seedLaunchPlan(db: Db, s: Seeded, launchDate: string, statuses: Partial<Record<string, "todo" | "done" | "skipped">> = {}) {
  const planId = uuidv7();
  await db.insert(schema.launchPlans).values({
    id: planId,
    workspaceId: s.workspaceId,
    productId: s.productId,
    campaignId: s.campaignId,
    startDate: "2026-10-07",
    launchDate,
    status: "active",
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
      status: statuses[key] ?? "todo",
    });
  }
  return planId;
}
