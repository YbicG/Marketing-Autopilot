import { and, eq } from "drizzle-orm";
import { schema } from "@mkt/db";
import { checkTrackingTest, TRACKING_TEST_KEY, type TrackingCheckDeps } from "./gates.ts";
import { refreshLaunchPlan } from "./plan.ts";

const { launchPlans, launchTasks } = schema;

export interface LaunchTickResult {
  plans: number;
  changed: number;
  trackingChecks: number;
  errors: { planId: string; message: string }[];
}

/**
 * launch.tick (maint, hourly): for every active plan, re-check an open tracking test (when a test
 * link exists), then evaluate and write task statuses. One plan failing doesn't stop the rest.
 */
export async function launchTick(deps: TrackingCheckDeps): Promise<LaunchTickResult> {
  const now = deps.now?.() ?? new Date();
  const plans = await deps.db.select().from(launchPlans).where(eq(launchPlans.status, "active"));
  const out: LaunchTickResult = { plans: plans.length, changed: 0, trackingChecks: 0, errors: [] };
  for (const plan of plans) {
    try {
      const [test] = await deps.db
        .select()
        .from(launchTasks)
        .where(and(eq(launchTasks.launchPlanId, plan.id), eq(launchTasks.key, TRACKING_TEST_KEY), eq(launchTasks.mode, "gate")));
      if (test && test.status !== "done" && test.ref?.utmContent) {
        out.trackingChecks++;
        await checkTrackingTest({ ...deps, now: () => now }, plan.workspaceId, plan.productId);
      }
      const { changed } = await refreshLaunchPlan(deps.db, plan.workspaceId, plan.id, now);
      out.changed += changed.length;
    } catch (err) {
      out.errors.push({ planId: plan.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
