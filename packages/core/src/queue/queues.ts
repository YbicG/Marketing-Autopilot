import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

/** The 5 queues of §3.3. M0 uses `ingest` only. */
export const QUEUE_NAMES = ["ingest", "generate", "render", "publish", "maint"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface IngestJobs {
  "m0.summary": { runId: string };
}

/**
 * Paid jobs get exactly one attempt (§3.3): retrying a paid call would silently spend twice.
 * Free jobs get 3 with exponential backoff.
 */
export function jobDefaults(paid: boolean): JobsOptions {
  return paid
    ? { attempts: 1, removeOnComplete: { age: 7 * 86_400 }, removeOnFail: { age: 30 * 86_400 } }
    : {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 7 * 86_400 },
        removeOnFail: { age: 30 * 86_400 },
      };
}

export const PAID_JOBS = new Set<string>(["m0.summary"]);

export function ingestQueue(connection: ConnectionOptions): Queue<IngestJobs[keyof IngestJobs], unknown, keyof IngestJobs> {
  return new Queue("ingest", { connection });
}

export async function enqueueIngest<N extends keyof IngestJobs>(
  queue: Queue<IngestJobs[keyof IngestJobs], unknown, keyof IngestJobs>,
  name: N,
  data: IngestJobs[N],
  jobId: string,
): Promise<void> {
  await queue.add(name, data, { ...jobDefaults(PAID_JOBS.has(name)), jobId });
}
