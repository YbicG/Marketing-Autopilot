export class StreamStalled extends Error {
  constructor(readonly idleMs: number) {
    super(`No stream event for ${Math.round(idleMs / 1000)} s`);
    this.name = "StreamStalled";
  }
}

interface AbortableStream {
  on(event: "streamEvent", listener: () => void): unknown;
  abort(): void;
  finalMessage(): Promise<unknown>;
}

/**
 * Await a stream's final message, aborting if no event arrives for `idleMs` (default 90 s).
 * Thinking streams keep sending events, so silence this long means the connection is dead.
 */
export async function withWatchdog<S extends AbortableStream>(
  stream: S,
  idleMs = 90_000,
): Promise<Awaited<ReturnType<S["finalMessage"]>>> {
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      stream.abort();
    }, idleMs);
  };
  stream.on("streamEvent", arm);
  arm();
  try {
    return (await stream.finalMessage()) as Awaited<ReturnType<S["finalMessage"]>>;
  } catch (err) {
    throw stalled ? new StreamStalled(idleMs) : err;
  } finally {
    clearTimeout(timer);
  }
}
