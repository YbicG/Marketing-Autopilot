import type { Db } from "@mkt/db";
import { orchestrate, rewriteVariant, runItem, type EngineDeps, type RewriteDeps } from "@mkt/core/engine";
import type { GenerateJobs, QueueOf } from "@mkt/core/queue";
import { generateGateway } from "./gateway.ts";

type RateLookup = EngineDeps["rates"];
type Client = NonNullable<EngineDeps["client"]>;
type Publish = NonNullable<EngineDeps["publish"]>;
type Generators = NonNullable<EngineDeps["generators"]>;

export { generateGateway, ORCHESTRATE_TICK_MS, type GenerateGateway } from "./gateway.ts";

export interface GenerateWorkerDeps {
  db: Db;
  /** Re-read per job so a corrected price applies without a redeploy. */
  rates: () => Promise<RateLookup>;
  client?: Client;
  publish?: Publish;
  generators?: Generators;
  /** The publishing state machine's "edit" event (§4.3), for rewrites of approved posts. */
  onVariantEdited?: (variantId: string) => Promise<void>;
  videoItem?: EngineDeps["videoItem"];
  gateway: ReturnType<typeof generateGateway>;
}

export function createGenerateDeps(input: {
  db: Db;
  rates: () => Promise<RateLookup>;
  generateQueue: QueueOf<"generate">;
  renderQueue?: QueueOf<"render">;
  client?: Client;
  publish?: Publish;
  generators?: Generators;
  onVariantEdited?: (variantId: string) => Promise<void>;
  videoItem?: EngineDeps["videoItem"];
}): GenerateWorkerDeps {
  const { generateQueue, renderQueue, ...rest } = input;
  return { ...rest, gateway: generateGateway(generateQueue, renderQueue) };
}

async function engineDeps(deps: GenerateWorkerDeps): Promise<EngineDeps> {
  return {
    db: deps.db,
    rates: await deps.rates(),
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.publish ? { publish: deps.publish } : {}),
    ...(deps.generators ? { generators: deps.generators } : {}),
    ...(deps.videoItem ? { videoItem: deps.videoItem } : {}),
    ...deps.gateway,
  };
}

export async function packageOrchestrate(deps: GenerateWorkerDeps, data: GenerateJobs["package.orchestrate"]) {
  return orchestrate(await engineDeps(deps), data.runId);
}

export async function packageItem(deps: GenerateWorkerDeps, data: GenerateJobs["package.item"]) {
  await runItem(await engineDeps(deps), data.runId, data.contentItemId);
}

export async function copyRewrite(deps: GenerateWorkerDeps, data: GenerateJobs["copy.rewrite"]) {
  const e = await engineDeps(deps);
  const r: RewriteDeps = { ...e, ...(deps.onVariantEdited ? { onVariantEdited: deps.onVariantEdited } : {}) };
  return rewriteVariant(r, data.runId, data.variantId);
}

/** Job names this module handles; video.finalize belongs to the video pipeline. */
export const GENERATE_JOBS = ["package.orchestrate", "package.item", "copy.rewrite"] as const;

/** Dispatch by job name for the generate Worker's processor. Returns false for names it doesn't own. */
export async function runGenerateJob(deps: GenerateWorkerDeps, name: string, data: unknown): Promise<unknown> {
  switch (name) {
    case "package.orchestrate":
      return packageOrchestrate(deps, data as GenerateJobs["package.orchestrate"]);
    case "package.item":
      return packageItem(deps, data as GenerateJobs["package.item"]);
    case "copy.rewrite":
      return copyRewrite(deps, data as GenerateJobs["copy.rewrite"]);
    default:
      return false;
  }
}
