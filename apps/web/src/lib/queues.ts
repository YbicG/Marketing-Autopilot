import { Redis } from "ioredis";
import { env } from "@mkt/core/config";
import { analyticsScheduler } from "@mkt/core/analytics";
import { applyEmailEffects, type EmailEffect, type EmailEnqueue } from "@mkt/core/email";
import { bullAnalyticsGateway, bullJobGateway, scheduleEffects, type Effect, type EffectDeps } from "@mkt/core/publishing";
import { enqueue, queueFor, type PublishJobs, type QueueName, type QueueOf } from "@mkt/core/queue";

let connection: Redis | undefined;
const queues = new Map<QueueName, unknown>();

/** Shared BullMQ producers for the web app. Lazy so `next build` never connects. */
export function getQueue<Q extends QueueName>(name: Q): QueueOf<Q> {
  connection ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
  let q = queues.get(name) as QueueOf<Q> | undefined;
  if (!q) {
    q = queueFor(name, connection) as QueueOf<Q>;
    queues.set(name, q);
  }
  return q;
}

/** Queue effects from the publishing engine (approve, edit, pause, reschedule) → BullMQ. */
export function publishEffects(): EffectDeps {
  return {
    gateway: bullJobGateway(getQueue("publish")),
    scheduleAnalytics: analyticsScheduler(bullAnalyticsGateway(getQueue("maint"))),
  };
}

/** Apply every { postId, effects } pair after the DB transaction committed. */
export async function applyEffects(list: { postId: string; effects: Effect[] }[]): Promise<void> {
  const deps = publishEffects();
  for (const r of list) await scheduleEffects(deps, r.postId, r.effects);
}

/** Broadcast follow-ups (submit / cancel at Resend) → the publish queue, with the machine's job ids. */
export function emailEnqueue(): EmailEnqueue {
  const q = getQueue("publish");
  return async (job) => {
    const opts = { jobId: job.jobId, ...(job.delayMs ? { delayMs: job.delayMs } : {}) };
    if (job.name === "email.submit") await enqueue<"publish", "email.submit">(q, "email.submit", job.data as PublishJobs["email.submit"], opts);
    else await enqueue<"publish", "email.cancel">(q, "email.cancel", job.data as PublishJobs["email.cancel"], opts);
  };
}

/** Apply broadcast effects after the DB write committed (approve, edit, void, cancel, pause). */
export async function applyBroadcastEffects(effects: readonly EmailEffect[]): Promise<void> {
  await applyEmailEffects(emailEnqueue(), effects);
}
