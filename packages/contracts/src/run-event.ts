import { z } from "zod";

/** Every live-progress event a worker can emit (§3.4). The SSE route forwards these verbatim. */
export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage_started"), stage: z.string(), label: z.string() }),
  z.object({ type: z.literal("stage_progress"), stage: z.string(), message: z.string() }),
  z.object({ type: z.literal("stage_done"), stage: z.string() }),
  /** A step that failed without ending the run (e.g. the repo was private). */
  z.object({ type: z.literal("stage_warning"), stage: z.string(), message: z.string() }),
  z.object({ type: z.literal("stage_skipped"), stage: z.string(), reason: z.string() }),
  z.object({ type: z.literal("fact_found"), text: z.string() }),
  z.object({ type: z.literal("asset_found"), assetId: z.string(), caption: z.string().nullable() }),
  z.object({ type: z.literal("competitor_found"), name: z.string(), url: z.string().nullable() }),
  z.object({ type: z.literal("quote_found"), text: z.string(), url: z.string().nullable() }),
  z.object({
    type: z.literal("question_ready"),
    questionId: z.string(),
    question: z.string(),
    options: z.array(z.string()),
  }),
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

/** The ingest run's steps, in display order (§2.3 "Reading your product"). */
export const INGEST_STAGES = [
  { id: "website", label: "Website" },
  { id: "repo", label: "Project folder / Repo" },
  { id: "notes", label: "Your notes" },
  { id: "screens", label: "Looking at screenshots" },
  { id: "questions", label: "A few questions" },
  { id: "research", label: "Similar products and what people complain about" },
  { id: "profile", label: "Writing your profile" },
] as const;
export const STRATEGY_STAGES = [{ id: "strategy", label: "Picking your angles" }] as const;
