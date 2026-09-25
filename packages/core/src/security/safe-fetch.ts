import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch, ProxyAgent, type Dispatcher, type Headers } from "undici";
import { assertPublicUrl, BlockedUrl, type Resolver } from "./ssrf.ts";
import { FetchTimeout } from "./timed-fetch.ts";

export interface SafeFetchOptions {
  selfIps?: readonly string[];
  /** http://smokescreen:4750 in production; when set, requests go through undici ProxyAgent (Smokescreen re-checks egress). */
  proxyUrl?: string;
  /** Default 50 MB. */
  maxBytes?: number;
  /** Default 20_000, whole request incl. redirects and body. */
  timeoutMs?: number;
  /** Default 5. */
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Only GET and HEAD. */
  method?: "GET" | "HEAD";
  /** Injectable DNS for tests. */
  resolve?: Resolver;
  /** Test-only: hostnames/IPs allowed despite being private. Taken from env SSRF_ALLOWLIST by the caller; never in prod. */
  allowHosts?: readonly string[];
}

export interface SafeResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Headers;
  contentType: string;
  body: Buffer;
  /** Every URL redirected to, in order. */
  redirects: string[];
}

const DEFAULTS = { maxBytes: 50 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 } as const;
const systemResolve: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Reads SSRF_ALLOWLIST (comma-separated) for tests that fetch from local servers. Refuses in
 * production, same as config/env().
 */
export function ssrfAllowHostsFromEnv(): string[] {
  const raw = process.env.SSRF_ALLOWLIST;
  if (!raw) return [];
  if (process.env.NODE_ENV === "production") {
    throw new Error("SSRF_ALLOWLIST is for tests only and is refused in production");
  }
  return raw.split(",").map((h) => normalizeHost(h.trim())).filter(Boolean);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * A socket lookup that ignores the hostname and only ever hands back the addresses we already
 * checked. Whatever DNS says at connect time (rebinding) never reaches the socket.
 * @internal exported for tests.
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  if (addresses.length === 0) throw new Error("pinnedLookup needs at least one address");
  const entries = addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
  return ((_hostname: string, options: { all?: boolean; family?: number | string } | undefined, callback: Function) => {
    const cb = (typeof options === "function" ? options : callback) as Function;
    const opts = typeof options === "object" && options ? options : {};
    const fam = opts.family === "IPv6" ? 6 : opts.family === "IPv4" ? 4 : typeof opts.family === "number" ? opts.family : 0;
    const matching = fam ? entries.filter((e) => e.family === fam) : entries;
    if (matching.length === 0) {
      const err = Object.assign(new Error("No pinned address for the requested family"), { code: "ENOTFOUND" });
      process.nextTick(() => cb(err));
      return;
    }
    if (opts.all) process.nextTick(() => cb(null, matching));
    else process.nextTick(() => cb(null, matching[0]!.address, matching[0]!.family));
  }) as LookupFunction;
}

/** Races a promise against the overall abort signal (DNS lookups can't be aborted). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Checks one hop and returns the addresses the connection must be pinned to. */
async function checkHop(url: string, opts: SafeFetchOptions, allow: Set<string>): Promise<{ url: URL; addresses: string[] }> {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // assertPublicUrl gives the plain message below.
  }
  const host = parsed ? normalizeHost(parsed.hostname) : "";
  if (parsed && allow.has(host)) {
    // Test-only escape hatch: private addresses and any port, but still http(s) and no userinfo.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BlockedUrl("Only http and https links are supported.", "scheme");
    }
    if (parsed.username || parsed.password) {
      throw new BlockedUrl("Links with a username or password aren't allowed.", "userinfo");
    }
    if (isIP(host)) return { url: parsed, addresses: [host] };
    let addresses: string[];
    try {
      addresses = await (opts.resolve ?? systemResolve)(host);
    } catch {
      throw new BlockedUrl("We couldn't find that website. Check the address.", "dns");
    }
    if (addresses.length === 0) throw new BlockedUrl("We couldn't find that website. Check the address.", "dns");
    return { url: parsed, addresses };
  }
  return assertPublicUrl(url, { selfIps: opts.selfIps, resolve: opts.resolve });
}

async function readCapped(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new BlockedUrl("That file is too large to fetch.", "too_large");
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetches an untrusted URL from Node (plan §8). Every hop is DNS-checked with assertPublicUrl and
 * the socket is pinned to exactly those addresses (no rebinding). Redirects are followed by hand
 * and re-checked. The body is capped and the whole thing has one deadline.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const method = opts.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    throw new BlockedUrl("Only GET and HEAD requests are allowed.", "method");
  }
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const allow = new Set((opts.allowHosts ?? []).map(normalizeHost));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new FetchTimeout("That website took too long to answer.")), timeoutMs);
  const proxy = opts.proxyUrl ? new ProxyAgent({ uri: opts.proxyUrl }) : null;
  const redirects: string[] = [];

  try {
    let current = rawUrl;
    for (;;) {
      const { url, addresses } = await raceAbort(checkHop(current, opts, allow), ctrl.signal);
      const agent: Dispatcher = proxy ?? new Agent({ connect: { lookup: pinnedLookup(addresses) } });
      try {
        const res = await fetch(url, {
          method,
          headers: opts.headers,
          redirect: "manual",
          signal: ctrl.signal,
          dispatcher: agent,
        });

        const location = res.headers.get("location");
        if (REDIRECT_STATUSES.has(res.status) && location) {
          await res.body?.cancel().catch(() => {});
          if (redirects.length >= maxRedirects) {
            throw new BlockedUrl("That link redirects too many times.", "too_many_redirects");
          }
          let next: string;
          try {
            next = new URL(location, url).href;
          } catch {
            throw new BlockedUrl("That website sent a broken redirect.", "bad_redirect");
          }
          redirects.push(next);
          current = next;
          continue;
        }

        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await res.body?.cancel().catch(() => {});
          throw new BlockedUrl("That file is too large to fetch.", "too_large");
        }
        const body = method === "HEAD" ? Buffer.alloc(0) : await readCapped(res.body, maxBytes);
        return {
          status: res.status,
          url: url.href,
          headers: res.headers,
          contentType: res.headers.get("content-type") ?? "",
          body,
          redirects,
        };
      } finally {
        if (agent !== proxy) await agent.destroy().catch(() => {});
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof FetchTimeout) throw ctrl.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    if (proxy) await proxy.destroy().catch(() => {});
  }
}

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m?.[1] ?? "utf-8";
}

/** safeFetch, decoded as text using the response charset (falls back to UTF-8). */
export async function safeFetchText(
  rawUrl: string,
  opts?: SafeFetchOptions,
): Promise<{ url: string; status: number; contentType: string; text: string }> {
  const res = await safeFetch(rawUrl, opts);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(res.contentType));
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return { url: res.url, status: res.status, contentType: res.contentType, text: decoder.decode(res.body) };
}
