import type { Redis } from "ioredis";
import { RunEvent, TERMINAL_EVENTS } from "@mkt/contracts";

/** §3.4: one Redis Stream per run, capped at ~2000 entries, kept a day after the run ends. */
export const runStreamKey = (runId: string) => `evt:run:${runId}`;
const MAXLEN = 2000;
const TTL_SECONDS = 24 * 60 * 60;

export async function publishRunEvent(redis: Redis, runId: string, event: RunEvent): Promise<string> {
  const data = JSON.stringify(RunEvent.parse(event));
  const key = runStreamKey(runId);
  const id = await redis.xadd(key, "MAXLEN", "~", String(MAXLEN), "*", "e", data);
  if (TERMINAL_EVENTS.has(event.type)) await redis.expire(key, TTL_SECONDS);
  return id!;
}

export interface StreamedEvent {
  id: string;
  event: RunEvent;
}

type XReadReply = [key: string, entries: [id: string, fields: string[]][]][] | null;

/** Parse an XREAD / XRANGE reply. Entries that fail validation are skipped, never forwarded. */
export function parseEntries(entries: [id: string, fields: string[]][]): StreamedEvent[] {
  const out: StreamedEvent[] = [];
  for (const [id, fields] of entries) {
    const idx = fields.indexOf("e");
    if (idx < 0) continue;
    const parsed = RunEvent.safeParse(JSON.parse(fields[idx + 1] ?? "null"));
    if (parsed.success) out.push({ id, event: parsed.data });
  }
  return out;
}

/**
 * Block up to `blockMs` for events after `lastId` ("0" replays from the start, which is what a
 * fresh page load wants). Uses its own connection: XREAD BLOCK ties the connection up.
 */
export async function readRunEvents(redis: Redis, runId: string, lastId: string, blockMs: number): Promise<StreamedEvent[]> {
  const reply = (await redis.xread("COUNT", 100, "BLOCK", blockMs, "STREAMS", runStreamKey(runId), lastId)) as XReadReply;
  if (!reply) return [];
  return reply.flatMap(([, entries]) => parseEntries(entries));
}

/** Stream ids look like `1727200000000-0`. Anything else from a client is replaced with "0". */
export function sanitizeLastEventId(raw: string | null | undefined): string {
  return raw && /^\d{1,20}-\d{1,10}$/.test(raw) ? raw : "0";
}
