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
