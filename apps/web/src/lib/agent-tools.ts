import { env, secret } from "@mkt/core/config";
import { enqueue } from "@mkt/core/queue";
import type { ToolDeps } from "@mkt/core/tools";
import { uuidv7 } from "@mkt/db";
import { getDb } from "./db";
import { getQueue } from "./queues";

/** What the agent tools need from the web app (§9): the DB, links back here, the confirm secret, the generate queue. */
export function toolDeps(): ToolDeps {
  return {
    db: getDb(),
    baseUrl: env().APP_BASE_URL,
    confirmSecret: () => secret("CONFIRM_TOKEN_SECRET"),
    // The same job "Make my campaign" enqueues (api/products/[slug]/package).
    enqueueOrchestrate: async (runId) => {
      await enqueue<"generate", "package.orchestrate">(getQueue("generate"), "package.orchestrate", { runId }, {
        jobId: `orch-${runId}-${uuidv7()}`,
        dedupe: `orch:${runId}`,
      });
    },
  };
}
