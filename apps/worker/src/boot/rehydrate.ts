import type { Queue } from "bullmq";
import type { Db } from "@mkt/db";
import { bullAnalyticsGateway, bullJobGateway, rehydrate, type RehydrateSummary } from "@mkt/core/publishing";
import type { QueueOf } from "@mkt/core/queue";

export { bullAnalyticsGateway, bullJobGateway };

/**
 * Repeating jobs of §3.3 for the publish engine. upsertJobScheduler is idempotent, so this runs on
 * every boot. reconcile is cheap when nothing is submitted/unknown (one indexed query).
 */
export async function ensurePublishSchedulers(publishQueue: QueueOf<"publish">, maintQueue: QueueOf<"maint">): Promise<void> {
  const pq = publishQueue as unknown as Queue;
  const mq = maintQueue as unknown as Queue;
  await pq.upsertJobScheduler("publish.reconcile", { every: 5 * 60_000 }, { name: "publish.reconcile", data: {} });
  await pq.upsertJobScheduler("publish.stale_sweep", { pattern: "15 4 * * *" }, { name: "publish.stale_sweep", data: {} });
  await mq.upsertJobScheduler("maint.conversions_pull", { pattern: "30 5 * * *" }, { name: "maint.conversions_pull", data: {} });
}

/** boot.rehydrate: run once per worker start, before the publish Worker starts taking jobs. */
export async function runBootRehydrate(deps: {
  db: Db;
  publishQueue: QueueOf<"publish">;
  maintQueue: QueueOf<"maint">;
  graceMin: number;
}): Promise<RehydrateSummary> {
  const summary = await rehydrate({
    db: deps.db,
    gateway: bullJobGateway(deps.publishQueue),
    analytics: bullAnalyticsGateway(deps.maintQueue),
    graceMin: deps.graceMin,
  });
  await ensurePublishSchedulers(deps.publishQueue, deps.maintQueue);
  console.log("[worker] boot.rehydrate", summary);
  return summary;
}
