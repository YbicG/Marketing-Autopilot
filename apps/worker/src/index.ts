import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, type Job, type Queue } from "bullmq";
import { Redis } from "ioredis";
import { createDb } from "@mkt/db";
import { env } from "@mkt/core/config";
import { loadRateCards, rateLookup, seedPricingRates } from "@mkt/core/cost";
import { executeIngestRun, executeRegenerateRun, executeStrategyRun, type IngestDeps } from "@mkt/core/ingest";
import { storage } from "@mkt/core/media";
import { dbConnectionStore, variantEditedHook, voidApprovalsForVariants } from "@mkt/core/publishing";
import { enqueue, enqueueIngest, ingestQueue, publishRunEvent, queueFor, type IngestJobs, type MaintJobs, type RenderJobs } from "@mkt/core/queue";
import { executeSummaryRun } from "@mkt/core/runs";
import { resolveSecret, safeFetchText, ssrfAllowHostsFromEnv } from "@mkt/core/security";
import { videoGenerator, workspaceOfContentItem, workspaceOfRender, type VideoDeps } from "@mkt/core/video";
import { ELEVENLABS_SECRET, createElevenLabsAudio, registeredPublishers } from "@mkt/providers";
import { framesToCfr } from "@mkt/video/render";
import { closeBrowser, fetchPageText } from "./capture/page-text.ts";
import { captureSite } from "./capture/site.ts";
import { bullJobGateway, runBootRehydrate } from "./boot/rehydrate.ts";
import { envNameFor, loginResolver, providerCtxFor } from "./boot/secrets.ts";
import { serverInfo } from "./boot/server-info.ts";
import { httpFirstPartyClient, runAnalyticsJob } from "./jobs/analytics/index.ts";
import { captureFlow } from "./jobs/capture/flow.ts";
import { createGenerateDeps, runGenerateJob } from "./jobs/generate/index.ts";
import { connectionsHealth } from "./jobs/maint/connections-health.ts";
import { heartbeat } from "./jobs/maint/heartbeat.ts";
import { pgBackup } from "./jobs/maint/pg-backup.ts";
import { storageGc } from "./jobs/maint/storage-gc.ts";
import { createPublishDeps, runPublishJob } from "./jobs/publish/index.ts";
import { heavyRunner } from "./jobs/render/heavy.ts";
import { ffmpegImageTools } from "./jobs/render/image.ts";
import { createVideoRenderer, specTools } from "./jobs/render/renderer.ts";
import { renderStillJob, renderVideoJob } from "./jobs/render/video.ts";
import { finalizeVideoJob } from "./jobs/video/finalize.ts";

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
const producerConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const events = new Redis(config.REDIS_URL);
events.on("error", (err) => console.error("[worker] redis error", err.message));
const semRedis = new Redis(config.REDIS_URL);

const producer = ingestQueue(producerConnection);
const generateQ = queueFor("generate", producerConnection);
const renderQ = queueFor("render", producerConnection);
const publishQ = queueFor("publish", producerConnection);
const maintQ = queueFor("maint", producerConnection);

const store = storage(config);
const allowHosts = ssrfAllowHostsFromEnv();
const graceMin = config.MISSED_SLOT_GRACE_MIN;
/** Rates are re-read per job so a corrected price applies without a redeploy. */
const rates = async () => rateLookup(await loadRateCards(db));
const ctxFor = (workspaceId: string) => providerCtxFor(db, workspaceId);
const fetchText = (url: string, init?: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number }) =>
  safeFetchText(url, {
    selfIps: config.SELF_IPS,
    proxyUrl: config.SMOKESCREEN_URL,
    allowHosts,
    headers: init?.headers,
    timeoutMs: init?.timeoutMs,
    maxBytes: init?.maxBytes ?? 5_000_000,
  });

function okText(r: { url: string; status: number; text: string }): string {
  if (r.status < 200 || r.status >= 300) throw new Error(`${new URL(r.url).host} answered ${r.status}`);
  return r.text;
}

/** Everything an M1 run needs. */
async function ingestDeps(runId: string): Promise<IngestDeps & { enqueueStrategy: (id: string) => Promise<void> }> {
  return {
    db,
    rates: await rates(),
    storage: store,
    publish: (e) => publishRunEvent(events, runId, e),
    captureSite: (url) => captureSite(url, { selfIps: config.SELF_IPS, proxyUrl: config.SMOKESCREEN_URL }),
    fetchText,
    githubToken: config.GITHUB_TOKEN,
    enqueueStrategy: (id) => enqueueIngest(producer, "strategy.run", { runId: id }, id),
  };
}

// ── publishing (M2) ──
const publishDeps = createPublishDeps({
  db,
  publishQueue: publishQ,
  maintQueue: maintQ,
  graceMin,
  ctxFor,
  openMedia: async (a) => store.get(a.storageKey),
});
const effects = { gateway: bullJobGateway(publishQ), scheduleAnalytics: publishDeps.scheduleAnalytics };
const voidApprovalsFor = voidApprovalsForVariants(db, effects, { graceMin });

// ── video (M3a) ──
const withHeavy = heavyRunner(semRedis);
const renderer = createVideoRenderer({ ff: { ffmpegPath: config.FFMPEG_PATH, ffprobePath: config.FFPROBE_PATH } });
const workDir = join(tmpdir(), "mkt-render");
const images = ffmpegImageTools({ ffmpegPath: config.FFMPEG_PATH, ffprobePath: config.FFPROBE_PATH });

/** Per workspace: the ElevenLabs key is vault-first (D19); without one, the captions-only cut + bundled track. */
async function videoDeps(workspaceId: string, runId?: string): Promise<VideoDeps> {
  const hasVoice = !!(await resolveSecret(db, workspaceId, ELEVENLABS_SECRET, envNameFor(ELEVENLABS_SECRET)));
  return {
    db,
    rates: await rates(),
    storage: store,
    audio: hasVoice ? createElevenLabsAudio() : null,
    providerCtx: ctxFor(workspaceId),
    renderer,
    tools: specTools,
    imageDecoder: images.decoder,
    imageResizer: images.resizer,
    ...(runId ? { publish: (e) => publishRunEvent(events, runId, e) } : {}),
    voidApprovalsFor,
    // A unique id per enqueue: the renders row (status + attempts) is the dedupe, and a render that
    // re-queues itself runs while its own job id is still active.
    enqueueRender: async (renderId, opts) => {
      await enqueue<"render", "render.video">(renderQ, "render.video", { renderId }, { jobId: `rv-${renderId}-${Date.now().toString(36)}`, ...(opts?.delayMs ? { delayMs: opts.delayMs } : {}) });
    },
    workDir,
    concurrency: config.REMOTION_CONCURRENCY,
    bundledTrackAssetId: null,
  };
}

const generateDeps = createGenerateDeps({
  db,
  rates,
  generateQueue: generateQ,
  renderQueue: renderQ,
  publish: (runId, e) => publishRunEvent(events, runId, e),
  generators: ["posts", "threads", "carousel", "bio", "video"],
  onVariantEdited: variantEditedHook(db, effects, { graceMin }),
  videoItem: async (ctx) => videoGenerator(await videoDeps(ctx.workspaceId, ctx.runId), ctx),
});

const analyticsDeps = {
  db,
  ctxFor,
  clientFor: (product: { urls: { website?: string } }) =>
    config.FIRSTPARTY_ANALYTICS_TOKEN && product.urls.website
      ? httpFirstPartyClient({ baseUrl: product.urls.website, token: config.FIRSTPARTY_ANALYTICS_TOKEN, fetchText: async (u, i) => okText(await fetchText(u, i)) })
      : null,
};

// ── workers ──
const failed = (job: Job | undefined, err: Error) => console.error("[worker] job failed", job?.queueName, job?.name, job?.id, err.message);
const workers: Worker[] = [];
function start(name: string, processor: (job: Job) => Promise<unknown>, concurrency: number) {
  const w = new Worker(name, processor, { connection: bullConnection, concurrency });
  w.on("failed", failed);
  workers.push(w);
  console.log(`[worker] ${name} queue ready (concurrency ${concurrency})`);
}

start(
  "ingest",
  async (job) => {
    const { runId } = job.data as IngestJobs[keyof IngestJobs];
    if (job.name === "ingest.run") return executeIngestRun(await ingestDeps(runId), runId);
    if (job.name === "strategy.run") return executeStrategyRun(await ingestDeps(runId), runId);
    if (job.name === "dna.regenerate") return executeRegenerateRun(await ingestDeps(runId), runId);
    if (job.name === "m0.summary") {
      await executeSummaryRun(
        { db, rates: await rates(), publish: (e) => publishRunEvent(events, runId, e), fetchPage: (url) => fetchPageText(url, config.SELF_IPS) },
        runId,
      );
      return;
    }
    throw new Error(`unknown ingest job ${job.name}`);
  },
  4,
);

start(
  "generate",
  async (job) => {
    if (job.name === "video.finalize") {
      const data = job.data as { runId: string; contentItemId: string };
      const ws = await workspaceOfContentItem(db, data.contentItemId);
      if (!ws) return;
      return finalizeVideoJob(await videoDeps(ws, data.runId), data);
    }
    const handled = await runGenerateJob(generateDeps, job.name, job.data);
    if (handled === false) throw new Error(`unknown generate job ${job.name}`);
    return handled;
  },
  8,
);

// Render queue at concurrency 1, and every heavy job also takes sem:heavy (§3.3).
start(
  "render",
  async (job) => {
    if (job.name === "render.video") {
      const data = job.data as RenderJobs["render.video"];
      const ws = await workspaceOfRender(db, data.renderId);
      if (!ws) return;
      return renderVideoJob({ ...(await videoDeps(ws)), withHeavy }, data);
    }
    if (job.name === "render.still") {
      const data = job.data as RenderJobs["render.still"];
      const ws = await workspaceOfContentItem(db, data.contentItemId);
      if (!ws) return;
      return renderStillJob({ ...(await videoDeps(ws)), withHeavy }, data);
    }
    if (job.name === "capture.flow") {
      return captureFlow(
        {
          db,
          rates: await rates(),
          storage: store,
          withHeavy,
          framesToCfr: (o) => framesToCfr({ ...o, ffmpegPath: config.FFMPEG_PATH, ffprobePath: config.FFPROBE_PATH }),
          resolveSecret: loginResolver(db),
          proxyUrl: config.SMOKESCREEN_URL,
        },
        job.data as RenderJobs["capture.flow"],
      );
    }
    throw new Error(`unknown render job ${job.name}`);
  },
  1,
);

// boot.rehydrate runs before the publish Worker takes jobs (§3.3).
await runBootRehydrate({ db, publishQueue: publishQ, maintQueue: maintQ, graceMin });
start("publish", (job) => runPublishJob(publishDeps, job.name, job.data), 4);

const connectionStore = dbConnectionStore(db);
start(
  "maint",
  async (job) => {
    switch (job.name as keyof MaintJobs) {
      case "maint.heartbeat":
        return heartbeat({ pingUrl: config.HEALTHCHECK_PING_URL }, {});
      case "maint.pg_backup":
        return pgBackup({ storage: store, databaseUrl: config.DATABASE_URL }, {});
      case "maint.storage_gc":
        return storageGc({ storage: store }, {});
      case "maint.connections_health":
        return connectionsHealth({ store: connectionStore, adapterFor: (id) => registeredPublishers().find((p) => p.meta.id === id), ctxFor }, {});
      case "maint.analytics_pull":
      case "maint.conversions_pull":
        return runAnalyticsJob(analyticsDeps, job.name, job.data);
      default:
        throw new Error(`unknown maint job ${job.name}`);
    }
  },
  1,
);

// Repeating maint jobs (§3.3). upsertJobScheduler is idempotent across boots.
const mq = maintQ as unknown as Queue;
await mq.upsertJobScheduler("maint.heartbeat", { every: 5 * 60_000 }, { name: "maint.heartbeat", data: {} });
await mq.upsertJobScheduler("maint.pg_backup", { pattern: "10 3 * * *" }, { name: "maint.pg_backup", data: {} });
await mq.upsertJobScheduler("maint.storage_gc", { pattern: "40 4 * * 0" }, { name: "maint.storage_gc", data: {} });
await mq.upsertJobScheduler("maint.connections_health", { every: 6 * 60 * 60_000 }, { name: "maint.connections_health", data: {} });

// Graceful deploys (§3.3): stop taking jobs, let running ones finish, then exit within the grace period.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal}: draining`);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([producer, generateQ, renderQ, publishQ, maintQ].map((q) => q.close()));
  await closeBrowser();
  await Promise.allSettled([bullConnection.quit(), producerConnection.quit(), events.quit(), semRedis.quit(), sql.end({ timeout: 5 })]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
