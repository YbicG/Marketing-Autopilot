import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDb } from "@mkt/db";
import { env } from "@mkt/core/config";
import { loadRateCards, rateLookup, seedPricingRates } from "@mkt/core/cost";
import { executeIngestRun, executeRegenerateRun, executeStrategyRun, type IngestDeps } from "@mkt/core/ingest";
import { storage } from "@mkt/core/media";
import { enqueueIngest, ingestQueue, publishRunEvent, type IngestJobs } from "@mkt/core/queue";
import { executeSummaryRun } from "@mkt/core/runs";
import { safeFetchText, ssrfAllowHostsFromEnv } from "@mkt/core/security";
import { closeBrowser, fetchPageText } from "./capture/page-text.ts";
import { captureSite } from "./capture/site.ts";
import { serverInfo } from "./boot/server-info.ts";

const config = env();
const info = serverInfo();
console.log("[worker] boot", { ...info, roles: config.WORKER_ROLES });
if (info.cpus < 4 || info.totalMemGb < 8) {
  console.warn("[worker] below the planned 4 vCPU / 8 GB; keep REMOTION_CONCURRENCY at 1");
}

const { db, sql } = createDb(config.DATABASE_URL);
await seedPricingRates(db); // idempotent; never overwrites corrected rows
console.log("[worker] pricing_rates seeded");

// BullMQ needs maxRetriesPerRequest: null on worker connections. Events get their own connection.
const bullConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const events = new Redis(config.REDIS_URL);
events.on("error", (err) => console.error("[worker] redis error", err.message));

const producer = ingestQueue(new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }));
const store = storage(config);
const allowHosts = ssrfAllowHostsFromEnv();

/** Everything an M1 run needs. Rates are re-read per run so a corrected price applies without a redeploy. */
async function ingestDeps(runId: string): Promise<IngestDeps & { enqueueStrategy: (id: string) => Promise<void> }> {
  return {
    db,
    rates: rateLookup(await loadRateCards(db)),
    storage: store,
    publish: (e) => publishRunEvent(events, runId, e),
    captureSite: (url) => captureSite(url, { selfIps: config.SELF_IPS, proxyUrl: config.SMOKESCREEN_URL }),
    fetchText: (url, init) =>
      safeFetchText(url, {
        selfIps: config.SELF_IPS,
        proxyUrl: config.SMOKESCREEN_URL,
        allowHosts,
        headers: init?.headers,
        timeoutMs: init?.timeoutMs,
        maxBytes: init?.maxBytes ?? 5_000_000,
      }),
    githubToken: config.GITHUB_TOKEN,
    enqueueStrategy: (id) => enqueueIngest(producer, "strategy.run", { runId: id }, id),
  };
}

const ingest = new Worker<IngestJobs[keyof IngestJobs], void, keyof IngestJobs>(
  "ingest",
  async (job) => {
    const { runId } = job.data;
    if (job.name === "ingest.run") return executeIngestRun(await ingestDeps(runId), runId);
    if (job.name === "strategy.run") return executeStrategyRun(await ingestDeps(runId), runId);
    if (job.name === "dna.regenerate") return executeRegenerateRun(await ingestDeps(runId), runId);
    if (job.name === "m0.summary") {
      // Rates are re-read per run so a corrected price applies without a redeploy.
      const rates = rateLookup(await loadRateCards(db));
      await executeSummaryRun(
        {
          db,
          rates,
          publish: (e) => publishRunEvent(events, runId, e),
          fetchPage: (url) => fetchPageText(url, config.SELF_IPS),
        },
        runId,
      );
      return;
    }
    throw new Error(`unknown ingest job ${job.name}`);
  },
  { connection: bullConnection, concurrency: 4 },
);
ingest.on("failed", (job, err) => console.error("[worker] job failed", job?.name, job?.id, err.message));
console.log("[worker] ingest queue ready");

// Graceful deploys (§3.3): stop taking jobs, let running ones finish, then exit within the grace period.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal}: draining`);
  await ingest.close().catch(() => undefined);
  await producer.close().catch(() => undefined);
  await closeBrowser();
  await Promise.allSettled([bullConnection.quit(), events.quit(), sql.end({ timeout: 5 })]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
