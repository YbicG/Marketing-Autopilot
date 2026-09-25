// sem:heavy (§3.3): at most one Remotion render / ffmpeg pass / demo capture at a time per server,
// on top of the render queue's concurrency 1 (a second worker process shares the same Redis key).

import type { Redis } from "ioredis";
import { HEAVY, RedisSemaphore, type SemaphoreRedis } from "@mkt/core/video";

export function ioredisSemaphore(redis: Redis): SemaphoreRedis {
  return {
    set: (key, value, px, ttlMs, nx) => redis.set(key, value, px, ttlMs, nx),
    eval: (script, numKeys, ...args) => redis.eval(script, numKeys, ...args),
  };
}

/** `withHeavy(fn)` for job deps (capture.flow already takes this shape). */
export function heavyRunner(redis: Redis, opts: { slots?: number } = {}) {
  const sem = new RedisSemaphore(ioredisSemaphore(redis), { name: HEAVY.name, slots: opts.slots ?? HEAVY.slots });
  return <T>(fn: () => Promise<T>): Promise<T> => sem.run(() => fn());
}
