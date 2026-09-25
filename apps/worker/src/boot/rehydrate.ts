import type { Job, Queue } from "bullmq";
import type { Db } from "@mkt/db";
import { rehydrate, type AnalyticsGateway, type JobGateway, type RehydrateSummary } from "@mkt/core/publishing";
import { enqueue, type QueueOf } from "@mkt/core/queue";

const LIVE = new Set(["delayed", "waiting", "active", "prioritized", "waiting-children"]);

async function existing(queue: Queue, jobId: string): Promise<{ job: Job; state: string } | null> {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  return { job, state: await job.getState() };
}

/**
 * JobGateway over the `publish` queue (D3). The jobId is the post's idempotency key, so BullMQ
 * itself refuses a duplicate; a finished job with the same id (e.g. a missed post re-queued with
 * "Post now") is removed first, since BullMQ ignores add() for an id it still remembers.
 */
export function bullJobGateway(publishQueue: QueueOf<"publish">): JobGateway {
  const q = publishQueue as unknown as Queue;
  const add = (job: { jobId: string; postId: string; generation: number; runAt: Date }) =>
    enqueue<"publish", "publish.due">(publishQueue, "publish.due", { postId: job.postId, generation: job.generation }, {
      jobId: job.jobId,
      delayMs: Math.max(0, job.runAt.getTime() - Date.now()),
    });
  return {
    async addDelayed(job) {
      const cur = await existing(q, job.jobId);
      if (cur?.state === "delayed") {
        await cur.job.changeDelay(Math.max(0, job.runAt.getTime() - Date.now()));
        return;
      }
      if (cur && LIVE.has(cur.state)) return;
      if (cur) await cur.job.remove().catch(() => undefined);
      await add(job);
    },
    async remove(jobId) {
      // A running job is locked and can't be removed; its handler re-checks the post state anyway.
      await q.remove(jobId).catch(() => 0);
    },
    async ensure(job) {
      const cur = await existing(q, job.jobId);
      if (cur && LIVE.has(cur.state)) return "exists";
      if (cur) await cur.job.remove().catch(() => undefined);
      await add(job);
      return "created";
    },
  };
}

/** maint.analytics_pull delayed jobs (jobId an_{postId}_{window}). */
export function bullAnalyticsGateway(maintQueue: QueueOf<"maint">): AnalyticsGateway {
  const q = maintQueue as unknown as Queue;
  return {
    async ensure(job) {
      if (await q.getJob(job.jobId)) return "exists";
      await enqueue<"maint", "maint.analytics_pull">(maintQueue, "maint.analytics_pull", { postId: job.postId, window: job.window }, {
        jobId: job.jobId,
        delayMs: Math.max(0, job.runAt.getTime() - Date.now()),
      });
      return "created";
    },
  };
}

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
