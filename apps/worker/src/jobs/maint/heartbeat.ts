import type { MaintJobs } from "@mkt/core/queue";

/**
 * maint.heartbeat (§3.5): a dead-man ping to HEALTHCHECK_PING_URL (Healthchecks.io) every 5 min.
 * If the worker stops, the pings stop and the external check emails CJ. A failed ping only logs:
 * retrying would just hide the gap the check exists to notice.
 */
export interface HeartbeatDeps {
  pingUrl?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export async function heartbeat(deps: HeartbeatDeps, _data: MaintJobs["maint.heartbeat"]): Promise<void> {
  if (!deps.pingUrl) return;
  const doFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const log = deps.log ?? ((m, e) => console.warn(m, e ?? ""));
  // Manual deadline: AbortSignal.timeout + fetch is unreliable on Node 24/Windows.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(deps.pingUrl, { method: "GET", signal: ctrl.signal });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) log("[worker] heartbeat ping answered", { status: res.status });
  } catch (err) {
    log("[worker] heartbeat ping failed", { error: (err as Error).message });
  } finally {
    clearTimeout(timer);
  }
}
