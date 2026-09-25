import { Redis } from "ioredis";
import { env } from "@mkt/core/config";
import { ingestQueue } from "@mkt/core/queue";

let producer: ReturnType<typeof ingestQueue> | undefined;

/** Shared BullMQ producer. Lazy so `next build` never connects. */
export function getIngestQueue() {
  producer ??= ingestQueue(new Redis(env().REDIS_URL, { maxRetriesPerRequest: null }));
  return producer;
}

/** One connection per SSE stream (§3.4): XREAD BLOCK ties the connection up. Caller must quit(). */
export function newStreamConnection(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
}
