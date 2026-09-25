import { Redis } from "ioredis";
import { env } from "@mkt/core/config";
import { analyticsScheduler } from "@mkt/core/analytics";
import { bullAnalyticsGateway, bullJobGateway, scheduleEffects, type Effect, type EffectDeps } from "@mkt/core/publishing";
import { queueFor, type QueueName, type QueueOf } from "@mkt/core/queue";

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
