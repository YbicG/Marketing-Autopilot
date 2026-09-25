import { describe, expect, it } from "vitest";
import { assertPublicUrl, BlockedUrl, isBlockedIp, parsePublicUrl } from "./ssrf.ts";

const resolveTo = (...ips: string[]) => async () => ips;

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5", // Docker bridge range
    "192.168.1.10",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe", // 169.254.169.254, hex-mapped
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  it("blocks the server's own public IPs", () => {
    expect(isBlockedIp("203.0.114.9", ["203.0.114.9"])).toBe(true);
  });
});

describe("parsePublicUrl", () => {
  it.each([
    ["ftp://example.com", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["http://user:pw@example.com", "userinfo"],
    ["http://example.com:8080", "port"],
    ["http://localhost", "internal_host"],
    ["http://redis", "internal_host"],
    ["http://printer.local", "internal_host"],
    ["http://intranet", "single_label"],
    ["not a url", "unparseable"],
  ])("refuses %s (%s)", (raw, reason) => {
    expect(() => parsePublicUrl(raw)).toThrow(BlockedUrl);
    try {
      parsePublicUrl(raw);
    } catch (e) {
      expect((e as BlockedUrl).reason).toBe(reason);
    }
  });

  it("normalizes decimal and hex IPs so they can't slip past", async () => {
    expect(parsePublicUrl("http://2130706433/").hostname).toBe("127.0.0.1");
    await expect(assertPublicUrl("http://0x7f.1/")).rejects.toMatchObject({ reason: "private_ip" });
    await expect(assertPublicUrl("http://[::ffff:169.254.169.254]/")).rejects.toMatchObject({ reason: "private_ip" });
  });
});

describe("assertPublicUrl", () => {
  it("allows a host whose records are all public", async () => {
    const r = await assertPublicUrl("https://syllacal.com", { resolve: resolveTo("104.21.1.1", "2606:4700::1") });
    expect(r.addresses).toHaveLength(2);
  });

  it("refuses when any record is private (DNS rebinding style)", async () => {
    await expect(
      assertPublicUrl("https://evil.example", { resolve: resolveTo("93.184.216.34", "10.0.0.5") }),
    ).rejects.toMatchObject({ reason: "private_ip", message: "That address points inside a private network." });
  });

  it("gives a plain message when DNS fails", async () => {
    await expect(
      assertPublicUrl("https://nope.example", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ reason: "dns" });
  });
});

describe("plan SSRF table", () => {
  const publicDns = resolveTo("93.184.216.34");

  it.each([
    // IPv4-mapped IPv6
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    // alternate IPv4 spellings the WHATWG parser normalizes
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    // special ranges
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://0.0.0.0/",
    "http://224.0.0.251/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[::1]/",
  ])("refuses %s as private_ip", async (raw) => {
    await expect(assertPublicUrl(raw, { resolve: publicDns })).rejects.toMatchObject({ reason: "private_ip" });
  });

  it.each([
    ["http://localhost/", "internal_host"],
    ["http://LOCALHOST./", "internal_host"],
    ["http://api.localhost/", "internal_host"],
    ["http://nas.local/", "internal_host"],
    ["http://metadata.google.internal/", "internal_host"],
    ["http://postgres/", "internal_host"],
    ["http://smokescreen/", "internal_host"],
    ["http://wiki/", "single_label"],
    ["http://user@example.com/", "userinfo"],
    ["http://example.com@127.0.0.1/", "userinfo"],
    ["http://:pw@example.com/", "userinfo"],
    ["http://example.com:8080/", "port"],
    ["https://example.com:8443/", "port"],
    ["gopher://example.com/", "scheme"],
    ["javascript:alert(1)", "scheme"],
  ])("refuses %s (%s)", async (raw, reason) => {
    await expect(assertPublicUrl(raw, { resolve: publicDns })).rejects.toMatchObject({ reason });
  });

  it("allows explicit standard ports", async () => {
    await expect(assertPublicUrl("http://example.com:80/", { resolve: publicDns })).resolves.toBeTruthy();
    await expect(assertPublicUrl("https://example.com:443/", { resolve: publicDns })).resolves.toBeTruthy();
  });

  it("refuses a hostname that resolves to the server's own IP (SELF_IPS)", async () => {
    await expect(
      assertPublicUrl("https://looks-public.example", { resolve: resolveTo("203.0.114.9"), selfIps: ["203.0.114.9"] }),
    ).rejects.toMatchObject({ reason: "private_ip" });
    await expect(assertPublicUrl("http://203.0.114.9/", { selfIps: ["203.0.114.9"] })).rejects.toMatchObject({
      reason: "private_ip",
    });
  });

  it("refuses when one private record hides among many public ones", async () => {
    await expect(
      assertPublicUrl("https://many.example", {
        resolve: resolveTo("93.184.216.34", "1.1.1.1", "2606:4700::1", "::ffff:169.254.169.254", "8.8.8.8"),
      }),
    ).rejects.toMatchObject({ reason: "private_ip" });
  });

  it("refuses a hostname with no records", async () => {
    await expect(assertPublicUrl("https://empty.example", { resolve: resolveTo() })).rejects.toMatchObject({ reason: "dns" });
  });
});
