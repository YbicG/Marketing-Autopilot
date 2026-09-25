/** A connector call that ran past its deadline. `message` is safe to show in the UI. */
export class FetchTimeout extends Error {
  readonly code = "timeout" as const;
  constructor(message = "The other service took too long to answer. Try again in a moment.") {
    super(message);
    this.name = "FetchTimeout";
  }
}

/**
 * Third-party connector fetch with a hard deadline. Manual AbortController (AbortSignal.timeout +
 * fetch is unreliable on Node 24/Windows). Links a caller signal instead of replacing it: aborting
 * the caller's signal aborts the request with the caller's reason. The deadline also covers reading
 * the body, so a server that trickles bytes forever is cut off too. Never used for the Anthropic SDK.
 */
export async function timedFetch(input: string | URL, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { timeoutMs, signal: callerSignal, ...rest } = init;
  const ctrl = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => ctrl.abort(callerSignal?.reason);
  const cleanup = () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new FetchTimeout());
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }, timeoutMs);
  // Keep the deadline armed while the caller reads the body, without holding the process open.
  timer.unref?.();

  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const res = await fetch(input, { ...rest, signal: ctrl.signal });
    if (!res.body) cleanup();
    return res;
  } catch (err) {
    cleanup();
    if (timedOut) throw new FetchTimeout();
    throw err;
  }
}
