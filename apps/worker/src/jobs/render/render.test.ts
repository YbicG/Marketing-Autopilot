import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { memorySemaphoreRedis } from "@mkt/core/video";
import { heavyRunner, ioredisSemaphore } from "./heavy.ts";

/** The subset of ioredis the adapter calls, backed by core's in-memory fake. */
function fakeIoredis(): Redis {
  const mem = memorySemaphoreRedis();
  return { set: mem.set.bind(mem), eval: mem.eval.bind(mem) } as unknown as Redis;
}

describe("sem:heavy in the worker", () => {
  it("passes set/eval through to ioredis", async () => {
    const sem = ioredisSemaphore(fakeIoredis());
    expect(await sem.set("k", "a", "PX", 1000, "NX")).toBe("OK");
    expect(await sem.set("k", "b", "PX", 1000, "NX")).toBeNull();
  });

  it("runs heavy jobs one at a time", async () => {
    const withHeavy = heavyRunner(fakeIoredis());
    let running = 0;
    let max = 0;
    const job = () =>
      withHeavy(async () => {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      });
    // Default poll is 2 s; two jobs keep this test short.
    await Promise.all([job(), job()]);
    expect(max).toBe(1);
  }, 15_000);
});
