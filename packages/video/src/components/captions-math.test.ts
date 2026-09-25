import { describe, expect, it } from "vitest";
import { captionCoverage, captionPages, pageAt } from "./captions-math.ts";

const words = ["Drop", " in", " your", " syllabus.", " Done."].map((text, i) => ({
  text,
  startMs: i * 400,
  endMs: i * 400 + 350,
  timestampMs: i * 400 + 175,
  confidence: null,
}));

describe("captions", () => {
  it("groups words into pages", () => {
    const pages = captionPages(words);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages.map((p) => p.text).join("")).toContain("syllabus");
  });
  it("finds the page at a time and nothing long after", () => {
    const pages = captionPages(words);
    expect(pageAt(pages, 0)?.text).toContain("Drop");
    expect(pageAt(pages, 60_000)).toBeNull();
    expect(pageAt(pages, -1)).toBeNull();
  });
  it("coverage is a share of the video", () => {
    const c = captionCoverage(words, 10_000);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(0.5);
    expect(captionCoverage(words, 0)).toBe(0);
  });
});
