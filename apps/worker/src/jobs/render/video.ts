// render.video and render.still (render queue, §3.3): heavy work under sem:heavy. The pipeline
// logic lives in @mkt/core/video; these are the queue-facing wrappers.

import type { RenderJobs } from "@mkt/core/queue";
import { executeRenderStill, executeRenderVideo, type RenderOutcome, type VideoDeps } from "@mkt/core/video";

export interface RenderJobDeps extends VideoDeps {
  withHeavy: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * One final render of one opening line. A crashed render re-queues itself (≤2 retries, counted on
 * the renders row), so BullMQ's own retry is only for errors thrown after that budget.
 */
export async function renderVideoJob(deps: RenderJobDeps, data: RenderJobs["render.video"]): Promise<RenderOutcome> {
  return deps.withHeavy(() => executeRenderVideo(deps, data.renderId));
}

export async function renderStillJob(deps: RenderJobDeps, data: RenderJobs["render.still"]): Promise<void> {
  await deps.withHeavy(() => executeRenderStill(deps, data));
}
