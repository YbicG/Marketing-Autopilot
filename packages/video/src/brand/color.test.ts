import { describe, expect, it } from "vitest";
import { contrastRatio, deriveBrandTokens, meetsContrast, mix, parseHex, readableOn } from "./color.ts";

describe("contrastRatio", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#fff", "#000")).toBe(contrastRatio("#000", "#fff"));
  });
  it("thresholds for body and large text", () => {
    expect(meetsContrast("#767676", "#ffffff")).toBe(true);
    expect(meetsContrast("#777777", "#ffffff")).toBe(false);
    expect(meetsContrast("#777777", "#ffffff", true)).toBe(true);
  });
});

describe("colour helpers", () => {
  it("parses short and long hex", () => {
    expect(parseHex("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(() => parseHex("red")).toThrow();
  });
  it("mixes", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  it("picks readable text", () => {
    expect(readableOn("#ffffff")).toBe("#0b0b0f");
    expect(readableOn("#111111")).toBe("#ffffff");
  });
});

describe("deriveBrandTokens", () => {
  it("never pairs text and background below 4.5:1", () => {
    for (const colors of [["#ffeb3b"], ["#6366f1", "#22d3ee", "#f5f5f5"], ["#000000", "#ffffff", "#0f172a"], ["#ff0000"]]) {
      const t = deriveBrandTokens({ colors, font: "Inter", logoAssetId: null });
      expect(contrastRatio(t.fg, t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.onPrimary, t.primary)).toBeGreaterThanOrEqual(3);
    }
  });
  it("uses a dark third colour as background, ignores a light one", () => {
    expect(deriveBrandTokens({ colors: ["#6366f1", "#22d3ee", "#0f172a"], font: "Inter", logoAssetId: null }).bg).toBe("#0f172a");
    expect(deriveBrandTokens({ colors: ["#6366f1", "#22d3ee", "#f5f5f5"], font: "Inter", logoAssetId: null }).bg).toBe("#0b0b0f");
  });
  it("falls back to bundled Inter for unknown fonts", () => {
    expect(deriveBrandTokens({ colors: ["#6366f1"], font: "Papyrus", logoAssetId: null }).fontFamily).toBe('"Inter", sans-serif');
  });
});
