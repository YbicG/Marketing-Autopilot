import type { Db } from "@mkt/db";
import { analyticsScheduler } from "@mkt/core/analytics";
import {
  handlePublishDue,
  processWebhookEvent,
  reconcilePosts,
  staleSweep,
  type PublishDeps,
  type WebhookDecoder,
} from "@mkt/core/publishing";
import type { PublishJobs, QueueOf } from "@mkt/core/queue";
import type { ProviderCtx } from "@mkt/providers";
import { bullAnalyticsGateway, bullJobGateway } from "../../boot/rehydrate.ts";

export interface PublishWorkerDeps extends PublishDeps {
  decodeWebhook?: WebhookDecoder;
}

/**
 * Everything the publish handlers need. `ctxFor` resolves secrets vault-first then env (A1's
 * resolveSecret in @mkt/core/security); `openMedia` reads the final file from storage.
 */
export function createPublishDeps(input: {
  db: Db;
  publishQueue: QueueOf<"publish">;
  maintQueue: QueueOf<"maint">;
  graceMin: number;
  ctxFor: (workspaceId: string) => ProviderCtx;
  openMedia: PublishDeps["openMedia"];
  decodeWebhook?: WebhookDecoder;
}): PublishWorkerDeps {
  return {
    db: input.db,
    gateway: bullJobGateway(input.publishQueue),
    graceMin: input.graceMin,
    ctxFor: input.ctxFor,
    openMedia: input.openMedia,
    scheduleAnalytics: analyticsScheduler(bullAnalyticsGateway(input.maintQueue)),
    ...(input.decodeWebhook ? { decodeWebhook: input.decodeWebhook } : {}),
  };
}

export function publishDue(deps: PublishWorkerDeps, data: PublishJobs["publish.due"]) {
  return handlePublishDue(deps, data);
}

export function publishReconcile(deps: PublishWorkerDeps, _data: PublishJobs["publish.reconcile"]) {
  return reconcilePosts(deps);
}

export function publishWebhook(deps: PublishWorkerDeps, data: PublishJobs["publish.webhook"]) {
  return processWebhookEvent(deps, data.webhookEventId, deps.decodeWebhook);
}

export function publishStaleSweep(deps: PublishWorkerDeps, data: PublishJobs["publish.stale_sweep"]) {
  return staleSweep(deps, data.productId ? { productId: data.productId } : {});
}

/** Dispatch by job name, for the publish Worker's processor. */
export async function runPublishJob(deps: PublishWorkerDeps, name: string, data: unknown): Promise<unknown> {
  switch (name) {
    case "publish.due":
      return publishDue(deps, data as PublishJobs["publish.due"]);
    case "publish.reconcile":
      return publishReconcile(deps, {});
    case "publish.webhook":
      return publishWebhook(deps, data as PublishJobs["publish.webhook"]);
    case "publish.stale_sweep":
      return publishStaleSweep(deps, data as PublishJobs["publish.stale_sweep"]);
    default:
      throw new Error(`unknown publish job ${name}`);
  }
}
