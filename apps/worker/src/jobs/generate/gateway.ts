import { uuidv7 } from "@mkt/db";
import type { EngineDeps } from "@mkt/core/engine";
import { enqueue, type QueueOf } from "@mkt/core/queue";

/** A tick is a delayed safety pass while children run (§3.3; see package.ts orchestrate). */
export const ORCHESTRATE_TICK_MS = 60_000;

export type GenerateGateway = Pick<EngineDeps, "enqueueItem" | "enqueueOrchestrate" | "enqueueRenderStill">;

/**
 * BullMQ side of the package engine.
 * - package.item: jobId `${runId}:${deliverableKey}` (exactly 2 colons' worth of parts — BullMQ
 *   rejects custom ids with ":" unless split(":") has 3 parts), so a duplicate enqueue is a no-op.
 * - package.orchestrate: a fresh jobId each time plus dedupe `orch:{runId}`, so at most one pass is
 *   waiting at a time and a finished pass never blocks the next one (a fixed jobId would).
 * - ticks dedupe separately so a child's hand-back can't swallow the safety pass (or vice versa).
 */
export function generateGateway(generateQueue: QueueOf<"generate">, renderQueue?: QueueOf<"render">): GenerateGateway {
  return {
    enqueueItem: (runId, contentItemId, jobId) =>
      enqueue<"generate", "package.item">(generateQueue, "package.item", { runId, contentItemId }, { jobId }),
    enqueueOrchestrate: (runId, opts) =>
      opts?.tick
        ? enqueue<"generate", "package.orchestrate">(generateQueue, "package.orchestrate", { runId }, {
            jobId: `orch-tick-${runId}-${uuidv7()}`,
            delayMs: ORCHESTRATE_TICK_MS,
            dedupe: `orch-tick:${runId}`,
          })
        : enqueue<"generate", "package.orchestrate">(generateQueue, "package.orchestrate", { runId }, {
            jobId: `orch-${runId}-${uuidv7()}`,
            dedupe: `orch:${runId}`,
          }),
    ...(renderQueue
      ? {
          enqueueRenderStill: (contentItemId: string, variantId: string) =>
            enqueue<"render", "render.still">(renderQueue, "render.still", { contentItemId, variantId }, { jobId: `still-${variantId}` }),
        }
      : {}),
  };
}
