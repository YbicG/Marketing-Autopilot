import type { Db } from "@mkt/db";
import {
  cancelBroadcastAtResend,
  executeEmailDraft,
  processResendWebhook,
  reconcileScheduledBroadcasts,
  submitBroadcast,
  type EmailDraftDeps,
  type EmailEnqueue,
  type EmailJobDeps,
} from "@mkt/core/email";
import { enqueue, type GenerateJobs, type PublishJobs, type QueueOf } from "@mkt/core/queue";
import { resend, type ProviderCtx, type ResendProvider } from "@mkt/providers";

export interface EmailWorkerDeps extends EmailJobDeps {
  /** Re-read per job so a corrected price applies without a redeploy. */
  rates: () => Promise<EmailDraftDeps["rates"]>;
  client?: EmailDraftDeps["client"];
  publish?: EmailDraftDeps["publish"];
}

/** Follow-up email jobs (submit / cancel) go on the publish queue with the machine's job ids. */
export function emailEnqueue(publishQueue: QueueOf<"publish">): EmailEnqueue {
  return async (job) => {
    const opts = { jobId: job.jobId, ...(job.delayMs ? { delayMs: job.delayMs } : {}) };
    if (job.name === "email.submit") await enqueue<"publish", "email.submit">(publishQueue, "email.submit", job.data as PublishJobs["email.submit"], opts);
    else await enqueue<"publish", "email.cancel">(publishQueue, "email.cancel", job.data as PublishJobs["email.cancel"], opts);
  };
}

/**
 * Everything the email handlers need. `ctxFor` must resolve secrets vault first, then env (D19):
 * pass boot/secrets.ts providerCtxFor, so "resend.api_key" falls back to RESEND_API_KEY.
 */
export function createEmailDeps(input: {
  db: Db;
  publishQueue: QueueOf<"publish">;
  ctxFor: (workspaceId: string) => ProviderCtx;
  rates: EmailWorkerDeps["rates"];
  client?: EmailDraftDeps["client"];
  publish?: EmailDraftDeps["publish"];
  provider?: ResendProvider;
  now?: () => Date;
}): EmailWorkerDeps {
  return {
    db: input.db,
    provider: input.provider ?? resend,
    ctxFor: input.ctxFor,
    enqueue: emailEnqueue(input.publishQueue),
    rates: input.rates,
    ...(input.client ? { client: input.client } : {}),
    ...(input.publish ? { publish: input.publish } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
}

export function emailSubmitJob(deps: EmailWorkerDeps, data: PublishJobs["email.submit"]) {
  return submitBroadcast(deps, data.broadcastId);
}

export function emailCancelJob(deps: EmailWorkerDeps, data: PublishJobs["email.cancel"]) {
  return cancelBroadcastAtResend(deps, data);
}

export function emailWebhookJob(deps: EmailWorkerDeps, data: PublishJobs["email.webhook"]) {
  return processResendWebhook(deps, data.webhookEventId);
}

/** Optional safety net for missed webhooks: call from publish.reconcile or launch.tick. */
export function emailReconcile(deps: EmailWorkerDeps, graceMin = 30) {
  return reconcileScheduledBroadcasts(deps, { graceMin });
}

export async function emailDraftJob(deps: EmailWorkerDeps, data: GenerateJobs["email.draft"]) {
  return executeEmailDraft(
    {
      db: deps.db,
      rates: await deps.rates(),
      ...(deps.client ? { client: deps.client } : {}),
      ...(deps.publish ? { publish: deps.publish } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    data,
  );
}

/** Publish-queue email jobs. */
export const EMAIL_PUBLISH_JOBS = ["email.submit", "email.cancel", "email.webhook"] as const;
/** Generate-queue email jobs. */
export const EMAIL_GENERATE_JOBS = ["email.draft"] as const;

/** Dispatch by job name. Returns false for names it doesn't own, so callers can chain dispatchers. */
export async function runEmailJob(deps: EmailWorkerDeps, name: string, data: unknown): Promise<unknown> {
  switch (name) {
    case "email.submit":
      return emailSubmitJob(deps, data as PublishJobs["email.submit"]);
    case "email.cancel":
      return emailCancelJob(deps, data as PublishJobs["email.cancel"]);
    case "email.webhook":
      return emailWebhookJob(deps, data as PublishJobs["email.webhook"]);
    case "email.draft":
      return emailDraftJob(deps, data as GenerateJobs["email.draft"]);
    default:
      return false;
  }
}
