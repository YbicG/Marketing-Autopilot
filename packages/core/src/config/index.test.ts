import { afterEach, describe, expect, it, vi } from "vitest";

describe("secret()", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws when missing instead of falling back", async () => {
    vi.stubEnv("MKT_TEST_SECRET", "");
    const { secret } = await import("./index.ts");
    expect(() => secret("MKT_TEST_SECRET")).toThrow(/Missing required secret/);
  });

  it("returns the value when set", async () => {
    vi.stubEnv("MKT_TEST_SECRET", "abc");
    const { secret } = await import("./index.ts");
    expect(secret("MKT_TEST_SECRET")).toBe("abc");
  });
});
