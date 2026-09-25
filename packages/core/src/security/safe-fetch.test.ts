import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pinnedLookup, safeFetch, safeFetchText, ssrfAllowHostsFromEnv } from "./safe-fetch.ts";
import { BlockedUrl } from "./ssrf.ts";
import { FetchTimeout, timedFetch } from "./timed-fetch.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let port: number;
let handler: Handler = (_req, res) => res.end("unset");
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  hits.length = 0;
  server.closeAllConnections();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const local = { allowHosts: ["127.0.0.1"] } as const;

describe("safeFetch against a local server (allowHosts)", () => {
  it("fetches a plain 200 text response", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("hello, café");
    };
    const r = await safeFetchText(`${base}/hi`, local);
    expect(r).toMatchObject({ status: 200, url: `${base}/hi`, text: "hello, café" });
    expect(r.contentType).toContain("text/plain");

    const raw = await safeFetch(`${base}/hi`, local);
    expect(raw.body.toString("utf8")).toBe("hello, café");
    expect(raw.redirects).toEqual([]);
  });

  it("supports HEAD with an empty body", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<p>ignored</p>");
    };
    const r = await safeFetch(`${base}/`, { ...local, method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(hits[0]).toMatch(/^HEAD /);
  });

  it("follows a redirect chain within the limit, resolving relative Locations", async () => {
    handler = (req, res) => {
      const m = /^\/hop\/(\d+)$/.exec(req.url ?? "");
      const n = m ? Number(m[1]) : -1;
      if (n >= 0 && n < 3) {
        res.writeHead(n % 2 ? 301 : 302, { location: n === 0 ? "/hop/1" : `../hop/${n + 1}` });
        res.end();
      } else {
        res.end(`landed ${req.url}`);
      }
    };
    const r = await safeFetchText(`${base}/hop/0`, local);
    expect(r.text).toBe("landed /hop/3");
    expect(r.url).toBe(`${base}/hop/3`);
    const raw = await safeFetch(`${base}/hop/0`, local);
    expect(raw.redirects).toEqual([`${base}/hop/1`, `${base}/hop/2`, `${base}/hop/3`]);
  });

  it("blocks a redirect to the cloud metadata address", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    };
    await expect(safeFetch(`${base}/`, local)).rejects.toMatchObject({ name: "BlockedUrl", reason: "private_ip" });
  });

  it("blocks a redirect to a non-standard port on a non-allowlisted host", async () => {
    handler = (_req, res) => {
      res.writeHead(307, { location: "http://example.com:8080/" });
      res.end();
    };
    await expect(safeFetch(`${base}/`, local)).rejects.toMatchObject({ reason: "port" });
  });

  it("stops a redirect loop after maxRedirects", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "/loop" });
      res.end();
    };
    await expect(safeFetch(`${base}/loop`, local)).rejects.toMatchObject({ reason: "too_many_redirects" });
    expect(hits).toHaveLength(6); // first request + 5 redirects followed
    await expect(safeFetch(`${base}/loop`, { ...local, maxRedirects: 1 })).rejects.toMatchObject({
      reason: "too_many_redirects",
    });
  });

  it("refuses a streamed body over maxBytes", async () => {
    handler = (_req, res) => {
      // chunked, no content-length: the cap must be enforced while streaming
      res.write(Buffer.alloc(600, 97));
      res.write(Buffer.alloc(600, 98));
      res.end();
    };
    await expect(safeFetch(`${base}/big`, { ...local, maxBytes: 1000 })).rejects.toMatchObject({ reason: "too_large" });
    const ok = await safeFetch(`${base}/big`, { ...local, maxBytes: 1200 });
    expect(ok.body.length).toBe(1200);
  });

  it("refuses early when content-length is over maxBytes", async () => {
    handler = (_req, res) => {
      res.setHeader("content-length", "5000");
      res.end(Buffer.alloc(5000));
    };
    await expect(safeFetch(`${base}/big`, { ...local, maxBytes: 1000 })).rejects.toMatchObject({ reason: "too_large" });
  });

  it("times out a server that never answers", async () => {
    handler = () => {
      /* never respond */
    };
    const t0 = Date.now();
    await expect(safeFetch(`${base}/slow`, { ...local, timeoutMs: 200 })).rejects.toBeInstanceOf(FetchTimeout);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("times out a server that trickles the body (deadline covers the body)", async () => {
    handler = (_req, res) => {
      res.write("a");
      const iv = setInterval(() => res.write("a"), 50);
      res.on("close", () => clearInterval(iv));
    };
    await expect(safeFetch(`${base}/trickle`, { ...local, timeoutMs: 300 })).rejects.toBeInstanceOf(FetchTimeout);
  });

  it("refuses POST at the type level and at runtime", async () => {
    // @ts-expect-error only GET and HEAD are allowed
    await expect(safeFetch(`${base}/`, { ...local, method: "POST" })).rejects.toMatchObject({ reason: "method" });
    expect(hits).toHaveLength(0);
  });

  it("refuses userinfo and non-http schemes even for allowlisted hosts", async () => {
    await expect(safeFetch(`http://u:p@127.0.0.1:${port}/`, local)).rejects.toMatchObject({ reason: "userinfo" });
    await expect(safeFetch(`ftp://127.0.0.1:${port}/`, local)).rejects.toMatchObject({ reason: "scheme" });
  });
});

describe("safeFetch without an allowlist", () => {
  it("refuses a private host on a non-standard port", async () => {
    await expect(safeFetch(`${base}/`)).rejects.toMatchObject({ reason: "port" });
    expect(hits).toHaveLength(0);
  });

  it("refuses private hosts on standard ports", async () => {
    await expect(safeFetch("http://127.0.0.1/")).rejects.toBeInstanceOf(BlockedUrl);
    await expect(safeFetch("http://localhost/")).rejects.toMatchObject({ reason: "internal_host" });
    await expect(
      safeFetch("https://rebind.example/", { resolve: async () => ["93.184.216.34", "127.0.0.1"] }),
    ).rejects.toMatchObject({ reason: "private_ip" });
  });
});

describe("DNS rebinding: the socket is pinned to the checked addresses", () => {
  it("pinnedLookup ignores the hostname and returns only the pinned addresses", async () => {
    const lookup = pinnedLookup(["203.0.113.5", "2001:db8::5"]);
    const call = (host: string, opts: object) =>
      new Promise<unknown[]>((resolve, reject) =>
        (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(host, opts, (err, ...rest) =>
          err ? reject(err) : resolve(rest),
        ),
      );
    expect(await call("anything.example", {})).toEqual(["203.0.113.5", 4]);
    expect(await call("localhost", { all: true })).toEqual([
      [
        { address: "203.0.113.5", family: 4 },
        { address: "2001:db8::5", family: 6 },
      ],
    ]);
    expect(await call("x", { family: 6 })).toEqual(["2001:db8::5", 6]);
    await expect(call("x", { family: 4, all: true })).resolves.toEqual([[{ address: "203.0.113.5", family: 4 }]]);
    await expect(call("x", { family: 6, all: true })).resolves.toEqual([[{ address: "2001:db8::5", family: 6 }]]);
    expect(() => pinnedLookup([])).toThrow();
    expect(typeof (lookup satisfies LookupFunction)).toBe("function");
  });

  it("connects to the address that was checked, not a later DNS answer", async () => {
    handler = (req, res) => res.end(`served ${req.headers.host}`);
    // rebind.test does not exist in real DNS, so reaching the server proves the socket used the
    // pinned address. The resolver answers differently on the second call; it must not be asked again.
    const resolve = vi.fn<(host: string) => Promise<string[]>>().mockResolvedValueOnce(["127.0.0.1"]).mockResolvedValue(["10.66.66.66"]);
    const r = await safeFetchText(`http://rebind.test:${port}/`, { allowHosts: ["rebind.test"], resolve });
    expect(r.text).toBe(`served rebind.test:${port}`);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("re-resolves and re-checks each redirect hop", async () => {
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "http://evil.example/" });
        res.end();
      } else res.end("should not get here");
    };
    const resolve = vi.fn(async () => ["10.0.0.7"]);
    await expect(safeFetch(`${base}/start`, { ...local, resolve })).rejects.toMatchObject({ reason: "private_ip" });
    expect(resolve).toHaveBeenCalledWith("evil.example");
  });
});

describe("ssrfAllowHostsFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parses the comma-separated list", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SSRF_ALLOWLIST", " 127.0.0.1, Fixture.Test ,[::1]");
    expect(ssrfAllowHostsFromEnv()).toEqual(["127.0.0.1", "fixture.test", "::1"]);
  });

  it("is empty when unset", () => {
    vi.stubEnv("SSRF_ALLOWLIST", "");
    expect(ssrfAllowHostsFromEnv()).toEqual([]);
  });

  it("refuses in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SSRF_ALLOWLIST", "127.0.0.1");
    expect(() => ssrfAllowHostsFromEnv()).toThrow(/production/);
  });
});

describe("timedFetch", () => {
  it("returns the response when fast", async () => {
    handler = (_req, res) => res.end("quick");
    const res = await timedFetch(`${base}/`, { timeoutMs: 2000 });
    expect(await res.text()).toBe("quick");
  });

  it("throws FetchTimeout past the deadline", async () => {
    handler = () => {};
    await expect(timedFetch(`${base}/`, { timeoutMs: 150 })).rejects.toMatchObject({ code: "timeout", name: "FetchTimeout" });
  });

  it("links the caller's signal instead of replacing it", async () => {
    handler = () => {};
    const caller = new AbortController();
    const p = timedFetch(`${base}/`, { timeoutMs: 5000, signal: caller.signal });
    setTimeout(() => caller.abort(new Error("user cancelled")), 50);
    await expect(p).rejects.toThrow("user cancelled");

    const pre = new AbortController();
    pre.abort(new Error("already"));
    await expect(timedFetch(`${base}/`, { timeoutMs: 5000, signal: pre.signal })).rejects.toThrow("already");
  });
});
