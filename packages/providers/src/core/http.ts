/**
 * Provider HTTP with a hard per-request deadline. Same semantics as core's timedFetch (providers
 * can't import @mkt/core): a manual AbortController, never AbortSignal.timeout (it crashes on
 * Node 24/Windows), the caller's signal linked in, and the deadline also covering the body read.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export class ProviderTimeout extends Error {
  readonly code = "timeout" as const;
  constructor(message = "The other service took too long to answer. Try again in a moment.") {
    super(message);
    this.name = "ProviderTimeout";
  }
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface HttpResult {
  status: number;
  headers: Headers;
  /** Parsed JSON when the body is JSON, else null. */
  json: unknown;
  text: string;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

/** One request, body fully read inside the deadline. Never throws on a non-2xx: callers map status. */
export async function httpRequest(url: string, init: HttpInit = {}): Promise<HttpResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, fetch: doFetch = (u, i) => fetch(u, i), ...rest } = init;
  const ctrl = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => ctrl.abort(callerSignal?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new ProviderTimeout());
  }, timeoutMs);
  timer.unref?.();
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  try {
    const res = await doFetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: res.headers, json, text };
  } catch (err) {
    if (timedOut) throw new ProviderTimeout();
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export function isTimeout(err: unknown): boolean {
  return err instanceof ProviderTimeout || (err instanceof Error && err.name === "AbortError");
}
