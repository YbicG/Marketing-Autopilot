import { describe, expect, it } from "vitest";
import { textDensity } from "./density.ts";

describe("textDensity", () => {
  it("ok for a short slide", () => {
    const d = textDensity({ headline: "Every deadline, one calendar", body: "Drop in a syllabus." });
    expect(d.level).toBe("ok");
    expect(d.words).toBe(8);
    expect(d.reasons).toEqual([]);
  });
  it("dense for a long headline or many words", () => {
    expect(textDensity({ headline: "x".repeat(70) }).level).toBe("dense");
    expect(textDensity({ headline: "Hi", body: Array(35).fill("w").join(" ") }).level).toBe("dense");
  });
  it("too dense past the hard limits", () => {
    expect(textDensity({ headline: "Hi", body: Array(60).fill("w").join(" ") }).level).toBe("too_dense");
    expect(textDensity({ headline: "x".repeat(95) }).level).toBe("too_dense");
  });
});
