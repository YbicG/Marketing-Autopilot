import { z } from "zod";

export const HealthStatus = z.object({
  ok: z.boolean(),
  service: z.enum(["web", "worker"]),
  version: z.string(),
  checks: z.record(z.string(), z.enum(["ok", "fail"])),
});
export type HealthStatus = z.infer<typeof HealthStatus>;
