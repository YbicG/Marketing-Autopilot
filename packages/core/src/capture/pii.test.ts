import { describe, expect, it } from "vitest";
import { buildClickLog, normalizePointerEvent } from "./click-log.ts";
import { clampBox, luhnValid, piiReport, sampleEverySecond, scanTextForPii } from "./pii.ts";

const kinds = (t: string, opts = {}) => scanTextForPii(t, opts).map((h) => h.kind);

describe("Luhn", () => {
  it.each(["4242424242424242", "4111111111111111", "5555555555554444", "378282246310005", "6011111111111117"])("%s is valid", (n) => {
    expect(luhnValid(n)).toBe(true);
  });
  it.each(["4242424242424241", "1234567890123", "12345", "abcd", "42424242424242424242"])("%s is not", (n) => {
    expect(luhnValid(n)).toBe(false);
  });
});

describe("text PII scan", () => {
  it("finds emails but not reserved demo domains", () => {
    expect(kinds("reach me at jane.doe@acme-mail.com")).toEqual(["email"]);
    expect(kinds("demo@example.com, student@syllacal.test, a@b.example")).toEqual([]);
    expect(kinds("demo@syllacal-demo.app", { allowEmailDomains: ["syllacal-demo.app"] })).toEqual([]);
  });

  it("finds phone numbers, not dates or ids", () => {
    expect(kinds("Call (415) 555-0142")).toEqual(["phone"]);
    expect(kinds("Call 415-555-0142 or 415.555.0143")).toEqual(["phone", "phone"]);
    expect(kinds("+44 20 7946 0958")).toEqual(["phone"]);
    expect(kinds("Due 2026-09-25 at 10:30, order 12345678901234, BIO 101")).toEqual([]);
  });

  it("finds Luhn-valid card numbers with spaces or dashes only", () => {
    expect(kinds("Card 4242 4242 4242 4242")).toEqual(["card"]);
    expect(kinds("Card 4242-4242-4242-4242")).toEqual(["card"]);
    expect(kinds("Ref 4242 4242 4242 4241")).toEqual([]);
  });

  it("finds API-key-like strings through the secret-scan rules", () => {
    expect(kinds("ACME_API_KEY=q7Zr4Xk2Lp9Vw3Ns8Tb6Yh1Jd5Fm0Gc")).toEqual(["api_key"]);
    expect(kinds("token: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")).toContain("api_key");
  });

  it("masks samples", () => {
    const [h] = scanTextForPii("jane.doe@acme-mail.com");
    expect(h!.sample).not.toContain("jane.doe");
    expect(h!.sample).toContain("@acme-mail.com");
    expect(scanTextForPii("4242 4242 4242 4242")[0]!.sample).toBe("•••• 4242");
  });

  it("report flags any hit", () => {
    expect(piiReport([], []).piiHits).toBe(false);
    expect(piiReport([{ kind: "email", sample: "x" }], []).piiHits).toBe(true);
    expect(piiReport([], [{ tMs: 0, kind: "face", x: 0, y: 0, w: 0.1, h: 0.1 }]).piiHits).toBe(true);
  });
});

describe("frame sampling", () => {
  const frames = [0, 40, 900, 1_010, 1_500, 2_990, 3_000, 7_200].map((tMs) => ({ tMs }));
  it("takes the newest frame at or before each second, once", () => {
    expect(sampleEverySecond(frames).map((f) => f.tMs)).toEqual([0, 900, 1_500, 3_000, 7_200]);
  });
  it("spreads over the recording when capped", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ tMs: i * 1_000 }));
    const picked = sampleEverySecond(many, 10).map((f) => f.tMs);
    expect(picked).toHaveLength(10);
    expect(picked[0]).toBe(0);
    expect(picked[9]).toBe(119_000);
  });
  it("clamps boxes into the frame", () => {
    expect(clampBox({ x: -0.1, y: 0.5, w: 0.5, h: 0.8 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(clampBox({ x: 0.2, y: 0.2, w: 0, h: 0.1 })).toBeNull();
    expect(clampBox({ x: Number.NaN, y: 0, w: 1, h: 1 })).toBeNull();
  });
});

describe("click log normalization", () => {
  const t0 = 1_760_000_000_000;
  it("maps CSS px to 0..1 of the viewport and ms from the first frame", () => {
    expect(normalizePointerEvent({ type: "click", t: t0 + 1_234.4, x: 720, y: 450, vw: 1440, vh: 900 }, t0)).toEqual({
      tMs: 1_234,
      x: 0.5,
      y: 0.5,
      type: "click",
    });
    expect(normalizePointerEvent({ type: "move", t: t0 + 10, x: 195, y: 844, vw: 390, vh: 844 }, t0)).toEqual({ tMs: 10, x: 0.5, y: 1, type: "move" });
  });

  it("clamps out-of-viewport points and pre-roll times", () => {
    expect(normalizePointerEvent({ type: "move", t: t0 - 500, x: -20, y: 2_000, vw: 1440, vh: 900 }, t0)).toEqual({ tMs: 0, x: 0, y: 1, type: "move" });
  });

  it("drops junk from the page", () => {
    for (const bad of [
      { type: "keydown", t: t0, x: 1, y: 1, vw: 10, vh: 10 },
      { type: "click", t: "soon", x: 1, y: 1, vw: 10, vh: 10 },
      { type: "click", t: t0, x: Number.NaN, y: 1, vw: 10, vh: 10 },
      { type: "click", t: t0, x: 1, y: 1, vw: 0, vh: 10 },
      null,
    ]) {
      expect(normalizePointerEvent(bad as never, t0)).toBeNull();
    }
  });

  it("sorts, thins moves to ~60/s, keeps every click and scroll, drops events after the end", () => {
    const at = (type: string, dt: number, x: number) => ({ type, t: t0 + dt, x, y: x, vw: 100, vh: 100 });
    const raw = [at("move", 25, 10), at("move", 5, 5), at("move", 10, 6), at("click", 21, 10), at("scroll", 22, 10), at("click", 5_000, 10)];
    expect(buildClickLog(raw, t0, t0 + 1_000)).toEqual([
      { tMs: 5, x: 0.05, y: 0.05, type: "move" },
      { tMs: 21, x: 0.1, y: 0.1, type: "click" },
      { tMs: 22, x: 0.1, y: 0.1, type: "scroll" },
      { tMs: 25, x: 0.1, y: 0.1, type: "move" },
    ]);
  });
});
