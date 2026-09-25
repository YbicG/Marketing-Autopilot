import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDb } from "@mkt/db";
import { env } from "@mkt/core/config";
import { loadRateCards, rateLookup, seedPricingRates } from "@mkt/core/cost";
import { publishRunEvent, type IngestJobs } from "@mkt/core/queue";
import { executeSummaryRun } from "@mkt/core/runs";
import { closeBrowser, fetchPageText } from "./capture/page-text.ts";
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

const ingest = new Worker<IngestJobs[keyof IngestJobs], void, keyof IngestJobs>(
  "ingest",
  async (job) => {
    if (job.name === "m0.summary") {
      const { runId } = job.data;
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
  await closeBrowser();
  await Promise.allSettled([bullConnection.quit(), events.quit(), sql.end({ timeout: 5 })]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
