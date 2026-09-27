// launch.tick (maint, hourly): advance every active launch plan and re-check open tracking tests.

import { firstPartyAggregateFor, launchTick, type LaunchTickResult, type TrackingCheckDeps } from "@mkt/core/launch";
import type { MaintJobs } from "@mkt/core/queue";
import type { Db } from "@mkt/db";

export type LaunchTickDeps = TrackingCheckDeps;

/** Production deps: the first-party aggregate at product.urls.website, token from vault/env. */
export function launchTickDeps(db: Db): LaunchTickDeps {
  return { db, aggregateFor: firstPartyAggregateFor(db) };
}

export async function launchTickJob(deps: LaunchTickDeps, _data: MaintJobs["launch.tick"] = {}): Promise<LaunchTickResult> {
  const result = await launchTick(deps);
  for (const e of result.errors) console.warn(`[launch.tick] plan ${e.planId}: ${e.message}`);
  return result;
}
