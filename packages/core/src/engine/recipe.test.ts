import { describe, expect, it } from "vitest";
import { GENERATORS, PackageRecipe } from "@mkt/contracts";
import { estimatePackage, refillPriceMicros } from "./estimate.ts";
import { buildRecipe, slotsPerPlatform } from "./recipe.ts";

const ALL = [...GENERATORS];
const usd = (m: number) => m / 1_000_000;

describe("recipe (D12: cadence × platforms × 30 days)", () => {
  it("Standard web B2C matches §2.5", () => {
    const r = buildRecipe("web_b2c", "standard", { generators: ALL });
    expect(PackageRecipe.parse(r)).toBeTruthy();
    expect(slotsPerPlatform(r)).toEqual({ tiktok: 14, instagram: 14, youtube: 6, threads: 20, x: 22 });
    const line = (k: string) => r.lines.find((l) => l.key === k)!;
    expect(line("master")).toMatchObject({ count: 6, hooksPerMaster: 3, kind: "video" });
    expect(line("swipe").count).toBe(8);
    expect(line("text").count).toBe(20);
    expect(line("xthread").count).toBe(2);
    expect(line("bio").scheduled).toBe(false);
    expect(line("pinned").targets.map((t) => t.platform).sort()).toEqual(["threads", "x"]);
  });

  it("M2 leaves videos in the recipe but switched off", () => {
    const r = buildRecipe("web_b2c", "standard");
    expect(r.lines.find((l) => l.kind === "video")!.enabled).toBe(false);
    expect(r.lines.filter((l) => l.kind !== "video").every((l) => l.enabled)).toBe(true);
    // The Open video slots still count in the cadence.
    expect(slotsPerPlatform(r).youtube).toBe(6);
  });

  it("scales Quick down and Premium up", () => {
    const q = buildRecipe("web_b2c", "quick", { generators: ALL });
    const p = buildRecipe("web_b2c", "premium", { generators: ALL });
    expect(q.lines.find((l) => l.key === "master")!.count).toBe(2);
    expect(q.lines.find((l) => l.key === "xthread")).toBeUndefined();
    expect(p.lines.find((l) => l.key === "master")!.count).toBe(12);
    expect(p.brollPerMaster).toBe(true);
    expect(q.brollPerMaster).toBe(false);
  });

  it("limits to chosen platforms", () => {
    const r = buildRecipe("web_b2c", "standard", { platforms: ["x", "threads"] });
    expect(Object.keys(slotsPerPlatform(r)).sort()).toEqual(["threads", "x"]);
  });

  it("dev tool recipe follows §5.3", () => {
    const r = buildRecipe("devtool", "standard", { generators: ALL });
    expect(r.lines.find((l) => l.key === "master")).toMatchObject({ count: 4, hooksPerMaster: 2 });
    expect(slotsPerPlatform(r).bluesky).toBe(20);
    expect(r.audience).toBe("developers");
  });
});

describe("estimate goldens (§7.2)", () => {
  it("Standard ≈ $7 (5.50–9.50), about $5 Claude + $2 media", () => {
    const e = estimatePackage(buildRecipe("web_b2c", "standard", { generators: ALL }));
    expect(usd(e.expected)).toBeGreaterThan(6.5);
    expect(usd(e.expected)).toBeLessThan(7.5);
    expect(usd(e.low)).toBeGreaterThanOrEqual(5.5);
    expect(usd(e.high)).toBeLessThanOrEqual(9.5);
    expect(usd(e.llmMicros)).toBeGreaterThan(4.5);
    expect(usd(e.mediaMicros)).toBeCloseTo(2, 0);
    expect(e.capMicros).toBe(12_000_000);
    expect(e.high).toBeLessThan(e.capMicros);
  });
  it("Quick ≈ $2.50 and Premium ≈ $25", () => {
    const q = estimatePackage(buildRecipe("web_b2c", "quick", { generators: ALL }));
    const p = estimatePackage(buildRecipe("web_b2c", "premium", { generators: ALL }));
    expect(usd(q.expected)).toBeGreaterThan(2.2);
    expect(usd(q.expected)).toBeLessThan(2.8);
    expect(usd(p.expected)).toBeGreaterThan(23);
    expect(usd(p.expected)).toBeLessThan(27);
    expect(q.high).toBeLessThan(q.capMicros);
    expect(p.high).toBeLessThan(p.capMicros);
  });
  it("the M2 Quick text + swipe package stays ≤ $3 (M2 done-when)", () => {
    const e = estimatePackage(buildRecipe("web_b2c", "quick"));
    expect(usd(e.high)).toBeLessThanOrEqual(3);
    expect(e.mediaMicros).toBe(0);
  });
  it("disabled lines only count when asked", () => {
    const r = buildRecipe("web_b2c", "standard");
    expect(estimatePackage(r).expected).toBeLessThan(estimatePackage(r, { includeDisabled: true }).expected);
  });
  it("prices one open slot", () => {
    expect(refillPriceMicros("post")).toBeLessThan(100_000);
    expect(refillPriceMicros("video")).toBeGreaterThan(refillPriceMicros("carousel"));
  });
});
