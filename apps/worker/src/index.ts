import { Redis } from "ioredis";
import { createDb } from "@mkt/db";
import { env } from "@mkt/core/config";
import { seedPricingRates } from "@mkt/core/cost";
import { serverInfo } from "./boot/server-info.ts";

const config = env();
const info = serverInfo();
console.log("[worker] boot", { ...info, roles: config.WORKER_ROLES });
if (info.cpus < 4 || info.totalMemGb < 8) {
  console.warn("[worker] below the planned 4 vCPU / 8 GB; keep REMOTION_CONCURRENCY at 1");
}

// BullMQ requires maxRetriesPerRequest: null on worker connections.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("ready", () => console.log("[worker] redis ready"));
redis.on("error", (err) => console.error("[worker] redis error", err.message));

const { db, sql } = createDb(config.DATABASE_URL);
await seedPricingRates(db); // idempotent; never overwrites corrected rows
console.log("[worker] pricing_rates seeded");

// Queues, boot.rehydrate and job handlers are registered here as M0–M2 land.

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal}: draining`);
  await redis.quit().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
