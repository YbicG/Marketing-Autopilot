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
