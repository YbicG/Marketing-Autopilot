// §8 "SSRF": every URL the app fetches for a person is checked before the request and at every
// redirect hop; private, loopback, link-local, metadata and our own service addresses are refused,
// however the address is written. Only GET and HEAD. Bodies are capped.
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeFetch } from "../security/safe-fetch.ts";
import { assertPublicUrl, BlockedUrl, isBlockedIp, parsePublicUrl } from "../security/ssrf.ts";

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof BlockedUrl ? e.reason : `other: ${String(e)}`;
  }
};
const reasonOfAsync = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e) => (e instanceof BlockedUrl ? e.reason : `other: ${String(e)}`),
  );

describe("§8 SSRF: address checks", () => {
  it("only http(s) on standard ports, no username or password", () => {
    expect(reasonOf(() => parsePublicUrl("https://syllacal.com/pricing"))).toBe("ok");
    expect(reasonOf(() => parsePublicUrl("file:///etc/passwd"))).toBe("scheme");
    expect(reasonOf(() => parsePublicUrl("gopher://syllacal.com"))).toBe("scheme");
    expect(reasonOf(() => parsePublicUrl("https://user:pw@syllacal.com"))).toBe("userinfo");
    expect(reasonOf(() => parsePublicUrl("https://syllacal.com:8443"))).toBe("port");
    expect(reasonOf(() => parsePublicUrl("not a url"))).toBe("unparseable");
  });

  it("internal names are refused: localhost, .local/.internal, our compose services, single labels", () => {
    for (const u of ["http://localhost/", "http://printer.local/", "http://db.internal/", "http://postgres/", "http://redis/", "http://smokescreen/", "http://intranet/"]) {
      expect(reasonOf(() => parsePublicUrl(u))).not.toBe("ok");
    }
  });

  it("IPs written as decimal, octal or hex are caught once resolved", async () => {
    for (const u of ["http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://127.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
      expect(await reasonOfAsync(assertPublicUrl(u))).toBe("private_ip");
    }
  });

  it("private, loopback, link-local, carrier-grade NAT, metadata and v4-mapped v6 are blocked", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a00:1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("2606:4700::1111")).toBe(false);
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });

  it("one private DNS record is enough to refuse; the server's own IPs are refused too", async () => {
    const resolve = async () => ["93.184.216.34", "10.0.0.7"];
    expect(await reasonOfAsync(assertPublicUrl("https://rebind.example.com", { resolve }))).toBe("private_ip");
    expect(await reasonOfAsync(assertPublicUrl("https://self.example.com", { resolve: async () => ["203.0.114.9"], selfIps: ["203.0.114.9"] }))).toBe("private_ip");
    expect(await reasonOfAsync(assertPublicUrl("https://nx.example.com", { resolve: async () => [] }))).toBe("dns");
    expect(await reasonOfAsync(assertPublicUrl("https://ok.example.com", { resolve: async () => ["93.184.216.34"] }))).toBe("ok");
  });
});

describe("§8 SSRF: safeFetch", () => {
  let server: Server;
  let base: string;
  let handler: (res: ServerResponse) => void = (res) => res.end("");
  beforeAll(async () => {
    // A throwaway loopback listener inside the test process (same as security/safe-fetch.test.ts).
    server = createServer((_req, res) => handler(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const local = { allowHosts: ["127.0.0.1"] };

  it("only GET and HEAD", async () => {
    expect(await reasonOfAsync(safeFetch(`${base}/`, { ...local, method: "POST" as "GET" }))).toBe("method");
  });

  it("without the test allowlist, loopback is refused before any request", async () => {
    expect(await reasonOfAsync(safeFetch(`${base}/`))).toBe("port");
    expect(await reasonOfAsync(safeFetch("http://127.0.0.1/"))).toBe("private_ip");
  });

  it("every redirect hop is checked again: a redirect to the metadata address is refused", async () => {
    handler = (res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      res.end();
    };
    expect(await reasonOfAsync(safeFetch(`${base}/go`, local))).toBe("private_ip");
  });

  it("redirect loops and oversized bodies are stopped", async () => {
    handler = (res) => {
      res.statusCode = 302;
      res.setHeader("location", "/again");
      res.end();
    };
    expect(await reasonOfAsync(safeFetch(`${base}/loop`, { ...local, maxRedirects: 3 }))).toBe("too_many_redirects");
    handler = (res) => res.end(Buffer.alloc(2048));
    expect(await reasonOfAsync(safeFetch(`${base}/big`, { ...local, maxBytes: 1024 }))).toBe("too_large");
  });

  it.todo("in production all egress goes through the Smokescreen proxy, which re-checks it — server check (compose.prod.yml)");
});
