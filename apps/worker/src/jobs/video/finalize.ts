// video.finalize (generate queue, §5.6 step 7): Gate 1 check, final voice + transcript check +
// music, then one render.video job per opening line. Light work: no semaphore.

import type { GenerateJobs } from "@mkt/core/queue";
import { executeFinalizeJob, type VideoDeps } from "@mkt/core/video";

export async function finalizeVideoJob(deps: VideoDeps, data: GenerateJobs["video.finalize"]): Promise<void> {
  await executeFinalizeJob(deps, data);
}
