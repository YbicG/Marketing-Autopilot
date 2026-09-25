import { z } from "zod";

export const HealthStatus = z.object({
  ok: z.boolean(),
  service: z.enum(["web", "worker"]),
  version: z.string(),
  checks: z.record(z.string(), z.enum(["ok", "fail"])),
});
export type HealthStatus = z.infer<typeof HealthStatus>;
export * from "./run-event.ts";
export * from "./folder-intake.ts";
export * from "./dna.ts";
export * from "./strategy.ts";
export * from "./sources.ts";
export * from "./platforms.ts";
export * from "./recipe.ts";
export * from "./campaign-plan.ts";
export * from "./post-set.ts";
export * from "./carousel-spec.ts";
export * from "./vocabulary.ts";
export * from "./video-spec.ts";
export * from "./publishing.ts";
export * from "./capture-flow.ts";
export * from "./results.ts";
