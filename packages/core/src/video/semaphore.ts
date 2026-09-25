import { randomUUID } from "node:crypto";

/**
 * §3.3 `sem:heavy = 1`: render.video, render.still and capture.flow never run at the same time on
 * the box (each can use every core and GBs of RAM). A Redis lock per slot with a TTL that the
 * holder keeps renewing, so a crashed worker frees its slot after one TTL.
 *
 * The subset of ioredis this needs; tests pass a fake.
 */
export interface SemaphoreRedis {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Renew only if we still hold it. */
export const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
/** Release only if we still hold it (never delete another holder's lock after our TTL ran out). */
export const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export interface SemaphoreOptions {
  name?: string;
  slots?: number;
  ttlMs?: number;
  /** How long acquire() waits before giving up. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface Lease {
  key: string;
  token: string;
  /** Aborted if a renewal finds the lock gone (e.g. the process stalled past the TTL). */
  signal: AbortSignal;
  release(): Promise<void>;
}

export class SemaphoreBusy extends Error {
  readonly code = "semaphore_busy";
  constructor(name: string) {
    super(`Another heavy job is still running (${name}). This one will try again shortly.`);
    this.name = "SemaphoreBusy";
  }
}

export const HEAVY = { name: "sem:heavy", slots: 1 } as const;

export class RedisSemaphore {
  readonly name: string;
  private readonly slots: number;
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly redis: SemaphoreRedis,
    opts: SemaphoreOptions = {},
  ) {
    this.name = opts.name ?? HEAVY.name;
    this.slots = Math.max(1, opts.slots ?? HEAVY.slots);
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.waitMs = opts.waitMs ?? 30 * 60_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Try each slot once. */
  async tryAcquire(): Promise<Lease | null> {
    const token = randomUUID();
    for (let i = 0; i < this.slots; i++) {
      const key = `${this.name}:${i}`;
      if ((await this.redis.set(key, token, "PX", this.ttlMs, "NX")) === "OK") return this.lease(key, token);
    }
    return null;
  }

  async acquire(): Promise<Lease> {
    const deadline = this.now() + this.waitMs;
    for (;;) {
      const lease = await this.tryAcquire();
      if (lease) return lease;
      if (this.now() >= deadline) throw new SemaphoreBusy(this.name);
      await this.sleep(this.pollMs);
    }
  }

  /** Run `fn` while holding a slot; the slot is renewed every ttl/3 and always released. */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await fn(lease.signal);
    } finally {
      await lease.release();
    }
  }

  private lease(key: string, token: string): Lease {
    const ctrl = new AbortController();
    let released = false;
    const timer = setInterval(() => {
      void this.redis
        .eval(RENEW_SCRIPT, 1, key, token, this.ttlMs)
        .then((ok) => {
          if (!released && Number(ok) !== 1) ctrl.abort(new Error(`lost ${key}`));
        })
        .catch(() => undefined);
    }, Math.max(10, Math.floor(this.ttlMs / 3)));
    timer.unref?.();
    return {
      key,
      token,
      signal: ctrl.signal,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await this.redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
      },
    };
  }
}

/** In-memory SemaphoreRedis with real PX expiry against an injectable clock (tests, PROVIDER_MODE=fake). */
export function memorySemaphoreRedis(now: () => number = Date.now): SemaphoreRedis & { store: Map<string, { value: string; expiresAt: number }> } {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const e = store.get(key);
    if (e && e.expiresAt <= now()) store.delete(key);
    return store.get(key);
  };
  return {
    store,
    async set(key, value, _px, ttlMs, _nx) {
      if (live(key)) return null;
      store.set(key, { value, expiresAt: now() + ttlMs });
      return "OK";
    },
    async eval(script, _n, key, token, ttl) {
      const e = live(String(key));
      if (!e || e.value !== String(token)) return 0;
      if (script === RENEW_SCRIPT) {
        e.expiresAt = now() + Number(ttl);
        return 1;
      }
      if (script === RELEASE_SCRIPT) {
        store.delete(String(key));
        return 1;
      }
      throw new Error("unknown script");
    },
  };
}
