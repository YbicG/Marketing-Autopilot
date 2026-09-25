import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** A URL the app refuses to fetch. `message` is safe to show in the UI (plain English, §2.6). */
export class BlockedUrl extends Error {
  readonly code = "blocked_url";
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "BlockedUrl";
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home.arpa"];
/** Compose service names on the private networks. Plain single-label names are refused anyway. */
const BLOCKED_HOSTS = new Set(["localhost", "postgres", "redis", "web", "worker", "migrate", "smokescreen"]);

/** IPv4-mapped IPv6 (::ffff:10.0.0.1 or ::ffff:a00:1) is checked as the IPv4 it wraps. */
function unmapV4(ip: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const rest = m[1]!;
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return null;
  const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function isBlockedIp(ip: string, selfIps: readonly string[] = []): boolean {
  if (selfIps.includes(ip)) return true;
  const v4 = unmapV4(ip);
  if (v4) return isBlockedIp(v4, selfIps);
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6");
  return true; // not an IP at all: refuse
}

/**
 * Hostnames that are IPs written as decimal, octal or hex (http://2130706433, http://0x7f.1) are
 * normalized the way the WHATWG URL parser does, so `new URL()` already hands us dotted IPv4.
 * This returns the parsed URL or throws BlockedUrl, without doing DNS.
 */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BlockedUrl("That doesn't look like a web address.", "unparseable");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrl("Only http and https links are supported.", "scheme");
  }
  if (url.username || url.password) throw new BlockedUrl("Links with a username or password aren't allowed.", "userinfo");
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new BlockedUrl("Only standard web ports (80 and 443) are supported.", "port");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrl("That address points inside a private network.", "internal_host");
  }
  if (isIP(host) === 0 && !host.includes(".")) {
    throw new BlockedUrl("That address points inside a private network.", "single_label");
  }
  return url;
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Pre-check before any fetch: syntax, then every A/AAAA record must be public (one private record
 * is enough to refuse). Returns the addresses so the caller can pin the connection to them.
 */
export async function assertPublicUrl(
  raw: string,
  opts: { selfIps?: readonly string[]; resolve?: Resolver } = {},
): Promise<{ url: URL; addresses: string[] }> {
  const url = parsePublicUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (opts.resolve ?? systemResolver)(host);
    } catch {
      throw new BlockedUrl("We couldn't find that website. Check the address.", "dns");
    }
  }
  if (addresses.length === 0) throw new BlockedUrl("We couldn't find that website. Check the address.", "dns");
  if (addresses.some((a) => isBlockedIp(a, opts.selfIps))) {
    throw new BlockedUrl("That address points inside a private network.", "private_ip");
  }
  return { url, addresses };
}
