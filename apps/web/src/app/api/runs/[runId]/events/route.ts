import type { RunEvent } from "@mkt/contracts";
import { readRunEvents, sanitizeLastEventId } from "@mkt/core/queue";
import { getRun } from "@mkt/core/runs";
import { getDb } from "@/lib/db";
import { newStreamConnection } from "@/lib/redis";
import { json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BLOCK_MS = 15_000;

/**
 * §3.4: Server-Sent Events from the run's Redis Stream. A reconnect sends Last-Event-ID and
 * resumes after it; a fresh load replays from the start. Pings every 15 s keep proxies from
 * closing an idle stream.
 */
export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { runId } = await ctx.params;
  const run = await getRun(getDb(), s.workspaceId, runId);
  if (!run) return json(404, { error: "Run not found." });

  let lastId = sanitizeLastEventId(req.headers.get("last-event-id"));
  const redis = newStreamConnection();
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const finish = () => {
        redis.disconnect();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      req.signal.addEventListener("abort", finish);
      send("retry: 3000\n\n");

      try {
        while (!req.signal.aborted) {
          const events = await readRunEvents(redis, runId, lastId, BLOCK_MS);
          if (events.length === 0) {
            // The stream expires a day after the run; fall back to the stored outcome.
            if (lastId === "0" && (run.status === "completed" || run.status === "failed")) {
              const final: RunEvent =
                run.status === "completed"
                  ? { type: "run_completed" }
                  : { type: "stage_failed", stage: "run", code: "failed", message: "This run failed.", retryable: false };
              send(`data: ${JSON.stringify(final)}\n\n`);
              break;
            }
            send(": ping\n\n");
            continue;
          }
          let done = false;
          for (const { id, event } of events) {
            send(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
            lastId = id;
            if (event.type === "run_completed" || event.type === "stage_failed") done = true;
          }
          if (done) break;
        }
      } catch (err) {
        if (!req.signal.aborted) console.error("[sse] stream error", err);
      } finally {
        finish();
      }
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
