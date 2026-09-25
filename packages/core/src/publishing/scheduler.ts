import type { Effect } from "./state-machine.ts";

export interface DelayedPublishJob {
  /** = posts.idempotency_key, pst_{id}_g{n}. */
  jobId: string;
  postId: string;
  generation: number;
  runAt: Date;
}

/**
 * Our own scheduler (D3) talks to BullMQ only through this. The worker implements it over the
 * `publish` queue (apps/worker/src/boot/rehydrate.ts); tests use an in-memory map.
 */
export interface JobGateway {
  /** Add or move the delayed publish.due job. Replaces a finished job with the same id. */
  addDelayed(job: DelayedPublishJob): Promise<void>;
  /** Remove it if present; never throws for a missing or running job. */
  remove(jobId: string): Promise<void>;
  /** Idempotent: leaves a waiting/delayed job with this id alone (boot.rehydrate). */
  ensure(job: DelayedPublishJob): Promise<"created" | "exists">;
}

export type AnalyticsWindowName = "h24" | "h72" | "d7";

export interface AnalyticsJob {
  jobId: string;
  postId: string;
  window: AnalyticsWindowName;
  runAt: Date;
}

/** maint.analytics_pull delayed jobs. `ensure` is idempotent by jobId. */
export interface AnalyticsGateway {
  ensure(job: AnalyticsJob): Promise<"created" | "exists">;
}

export interface EffectDeps {
  gateway: JobGateway;
  /** Called for scheduleAnalytics; omitted means analytics windows are left to rehydrate. */
  scheduleAnalytics?: (postId: string, publishedAt: Date) => Promise<void>;
  /** Today / Needs-you cards are read from post state; this is an optional push (e.g. live event). */
  notify?: (postId: string, kind: string, reason: string) => Promise<void>;
}

/**
 * Turns queue effects into BullMQ operations, after the DB transaction committed. `submit` and
 * `lookup` are not run here: the due and reconcile handlers own those calls.
 */
export async function scheduleEffects(deps: EffectDeps, postId: string, effects: Effect[]): Promise<void> {
  for (const e of effects) {
    switch (e.type) {
      case "addDelayedJob":
        await deps.gateway.addDelayed({ jobId: e.jobId, postId: e.postId, generation: e.generation, runAt: e.runAt });
        break;
      case "removeDelayedJob":
        await deps.gateway.remove(e.jobId);
        break;
      case "scheduleAnalytics":
        await deps.scheduleAnalytics?.(postId, e.publishedAt);
        break;
      case "notify":
        await deps.notify?.(postId, e.kind, e.reason);
        break;
      case "submit":
      case "lookup":
      case "voidApproval":
        break;
    }
  }
}

/** In-memory gateway for tests and dry runs. */
export function memoryJobGateway() {
  const jobs = new Map<string, DelayedPublishJob & { status: "delayed" | "done" }>();
  const log: string[] = [];
  const gw: JobGateway & { jobs: typeof jobs; log: string[]; finish(jobId: string): void } = {
    jobs,
    log,
    async addDelayed(job) {
      log.push(`add:${job.jobId}`);
      jobs.set(job.jobId, { ...job, status: "delayed" });
    },
    async remove(jobId) {
      log.push(`remove:${jobId}`);
      jobs.delete(jobId);
    },
    async ensure(job) {
      const cur = jobs.get(job.jobId);
      if (cur && cur.status === "delayed") return "exists";
      log.push(`ensure:${job.jobId}`);
      jobs.set(job.jobId, { ...job, status: "delayed" });
      return "created";
    },
    finish(jobId) {
      const j = jobs.get(jobId);
      if (j) j.status = "done";
    },
  };
  return gw;
}

export function memoryAnalyticsGateway() {
  const jobs = new Map<string, AnalyticsJob>();
  const gw: AnalyticsGateway & { jobs: typeof jobs } = {
    jobs,
    async ensure(job) {
      if (jobs.has(job.jobId)) return "exists";
      jobs.set(job.jobId, job);
      return "created";
    },
  };
  return gw;
}
