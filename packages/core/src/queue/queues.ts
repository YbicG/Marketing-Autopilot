import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

/** The 5 queues of §3.3. M0–M1 use `ingest` only. */
export const QUEUE_NAMES = ["ingest", "generate", "render", "publish", "maint"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** M1 keeps every run on `ingest` (the strategy call is one Opus call); M2 moves generation to `generate`. */
export interface IngestJobs {
  "m0.summary": { runId: string };
  "ingest.run": { runId: string };
  "strategy.run": { runId: string };
  "dna.regenerate": { runId: string };
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

/** generate (§3.3): the package orchestrator and its children. jobId `${runId}:${deliverableKey}`. */
export interface GenerateJobs {
  "package.orchestrate": { runId: string };
  "package.item": { runId: string; contentItemId: string };
  "copy.rewrite": { runId: string; variantId: string };
  "video.finalize": { runId: string; contentItemId: string };
}

/** render (§3.3): everything heavy runs under the sem:heavy semaphore. */
export interface RenderJobs {
  "render.still": { contentItemId: string; variantId: string };
  "render.video": { renderId: string };
  "capture.flow": { flowId: string; runId?: string };
}

/** publish (§3.3): publish.due is delayed with jobId = the post's idempotency key. */
export interface PublishJobs {
  "publish.due": { postId: string; generation: number };
  "publish.reconcile": Record<string, never>;
  "publish.webhook": { webhookEventId: string };
  "publish.stale_sweep": { productId?: string };
}

export interface MaintJobs {
  "maint.heartbeat": Record<string, never>;
  "maint.analytics_pull": { postId: string; window: "h24" | "h72" | "d7" };
  "maint.conversions_pull": Record<string, never>;
  "maint.connections_health": Record<string, never>;
  "maint.alerts": Record<string, never>;
  "maint.pg_backup": Record<string, never>;
  "maint.storage_gc": Record<string, never>;
}

export interface AllJobs {
  ingest: IngestJobs;
  generate: GenerateJobs;
  render: RenderJobs;
  publish: PublishJobs;
  maint: MaintJobs;
}

/**
 * publish.due and publish.submit are NOT in this set on purpose: they make no paid call, and
 * submit safety comes from the idempotency key + lookup-before-retry (§5.8), not from attempts.
 * The publish.due handler itself never re-submits after a submit started (the post goes to unknown).
 */
export const PAID_JOBS = new Set<string>([
  "m0.summary",
  "ingest.run",
  "strategy.run",
  "dna.regenerate",
  "package.orchestrate",
  "package.item",
  "copy.rewrite",
  "video.finalize",
]);

/** Free jobs that must still run at most once per jobId (their handler reconciles instead of retrying). */
export const SINGLE_ATTEMPT_JOBS = new Set<string>(["publish.due"]);

export function queueFor<Q extends QueueName>(name: Q, connection: ConnectionOptions) {
  return new Queue<AllJobs[Q][keyof AllJobs[Q]], unknown, Extract<keyof AllJobs[Q], string>>(name, { connection });
}

export type QueueOf<Q extends QueueName> = ReturnType<typeof queueFor<Q>>;

export async function enqueue<Q extends QueueName, N extends Extract<keyof AllJobs[Q], string>>(
  queue: QueueOf<Q>,
  name: N,
  data: AllJobs[Q][N],
  opts: { jobId: string; delayMs?: number; dedupe?: string },
): Promise<void> {
  const base = SINGLE_ATTEMPT_JOBS.has(name) ? jobDefaults(true) : jobDefaults(PAID_JOBS.has(name));
  // BullMQ's generic add() signature doesn't narrow per job name; the AllJobs map above is the contract.
  await (queue as unknown as Queue).add(name, data, {
    ...base,
    jobId: opts.jobId,
    ...(opts.delayMs && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
    ...(opts.dedupe ? { deduplication: { id: opts.dedupe } } : {}),
  });
}

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
