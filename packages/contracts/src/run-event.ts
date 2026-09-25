import { z } from "zod";

/** Every live-progress event a worker can emit (§3.4). The SSE route forwards these verbatim. */
export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage_started"), stage: z.string(), label: z.string() }),
  z.object({ type: z.literal("stage_progress"), stage: z.string(), message: z.string() }),
  z.object({ type: z.literal("stage_done"), stage: z.string() }),
  z.object({ type: z.literal("fact_found"), text: z.string() }),
  z.object({ type: z.literal("cost_update"), spentMicros: z.number().int() }),
  z.object({ type: z.literal("artifact_ready"), kind: z.string(), id: z.string() }),
  z.object({ type: z.literal("needs_input"), message: z.string() }),
  z.object({
    type: z.literal("stage_failed"),
    stage: z.string(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({ type: z.literal("run_completed") }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const TERMINAL_EVENTS = new Set<RunEvent["type"]>(["run_completed", "stage_failed"]);

/** What the M0 summary run produces: a one-page plain-English read of the product. */
export const ProductSummary = z.object({
  name: z.string(),
  oneLiner: z.string(),
  whoItsFor: z.string(),
  whatItDoes: z.array(z.string()),
  pricing: z.string().nullable(),
  notes: z.string(),
});
export type ProductSummary = z.infer<typeof ProductSummary>;
