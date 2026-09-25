import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildLinkedInPdfFromImages } from "./pdf.ts";

// 1×1 PNG.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("buildLinkedInPdf", () => {
  it("one page per slide, sized to the image", async () => {
    const bytes = await buildLinkedInPdfFromImages([PNG, PNG, PNG], { title: "Swipe post" });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 1, height: 1 });
    expect(doc.getTitle()).toBe("Swipe post");
  });
  it("rejects empty input and non-images", async () => {
    await expect(buildLinkedInPdfFromImages([])).rejects.toThrow();
    await expect(buildLinkedInPdfFromImages([new Uint8Array([1, 2, 3, 4])])).rejects.toThrow();
  });
});
