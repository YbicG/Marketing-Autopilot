import { describe, expect, it } from "vitest";
import type { QueueOf } from "@mkt/core/queue";
import { generateGateway, ORCHESTRATE_TICK_MS } from "./gateway.ts";

type Added = { name: string; data: unknown; opts: Record<string, unknown> };
function fakeQueue() {
  const added: Added[] = [];
  const q = { add: async (name: string, data: unknown, opts: Record<string, unknown>) => void added.push({ name, data, opts }) };
  return { q: q as unknown as QueueOf<"generate"> & QueueOf<"render">, added };
}

describe("generate gateway", () => {
  it("uses the item jobId, one attempt, and separate dedupe for passes and ticks", async () => {
    const gen = fakeQueue();
    const ren = fakeQueue();
    const g = generateGateway(gen.q, ren.q);
    await g.enqueueItem("run1", "item1", "run1:post:text-01");
    await g.enqueueOrchestrate("run1");
    await g.enqueueOrchestrate("run1", { tick: true });
    await g.enqueueRenderStill!("item1", "var1");

    const [item, pass, tick] = gen.added;
    expect(item).toMatchObject({ name: "package.item", data: { runId: "run1", contentItemId: "item1" }, opts: { jobId: "run1:post:text-01", attempts: 1 } });
    expect(pass!.opts).toMatchObject({ deduplication: { id: "orch:run1" }, attempts: 1 });
    expect(String(pass!.opts.jobId)).toMatch(/^orch-run1-/);
    expect(String(pass!.opts.jobId)).not.toContain(":");
    expect(tick!.opts).toMatchObject({ deduplication: { id: "orch-tick:run1" }, delay: ORCHESTRATE_TICK_MS });
    expect(ren.added[0]).toMatchObject({ name: "render.still", data: { contentItemId: "item1", variantId: "var1" }, opts: { jobId: "still-var1", attempts: 3 } });
  });

  it("leaves render.still out without a render queue", () => {
    expect(generateGateway(fakeQueue().q).enqueueRenderStill).toBeUndefined();
  });
});
