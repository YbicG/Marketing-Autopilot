import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * The approval hash of a variant (§4.2 approvals.content_hash): text + platform options + final media
 * sha256s. Media is empty until a render exists; the publishing code recomputes it with the final files.
 */
export function variantContentHash(input: { platform: string; body: unknown; options?: Record<string, unknown>; mediaSha256s?: string[] }): string {
  return sha256Hex(canonicalJson({ platform: input.platform, body: input.body, options: input.options ?? {}, media: input.mediaSha256s ?? [] }));
}

/** Tiny per-key concurrency limiter (§3.3: p-limit per model inside the generate queue, Opus 3, Sonnet 6). */
export class KeyedLimit {
  private active = new Map<string, number>();
  private waiting = new Map<string, (() => void)[]>();
  constructor(private readonly limits: Record<string, number>, private readonly fallback = 4) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const max = this.limits[key] ?? this.fallback;
    if ((this.active.get(key) ?? 0) >= max) {
      await new Promise<void>((resolve) => {
        const q = this.waiting.get(key) ?? [];
        q.push(resolve);
        this.waiting.set(key, q);
      });
    } else {
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.get(key)?.shift();
      // Hand the slot straight to the next waiter; otherwise free it.
      if (next) next();
      else this.active.set(key, (this.active.get(key) ?? 1) - 1);
    }
  }
}
