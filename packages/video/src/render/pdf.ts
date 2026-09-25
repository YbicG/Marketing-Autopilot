import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

// LinkedIn swipe posts go up as a PDF document (D25): one rendered slide per page, page size in
// points equal to the slide's pixels so nothing is resampled.

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export async function buildLinkedInPdfFromImages(images: readonly Uint8Array[], opts: { title?: string } = {}): Promise<Uint8Array> {
  if (images.length === 0) throw new Error("No slides to put in the PDF");
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(opts.title);
  doc.setProducer("Marketing Autopilot");
  doc.setCreator("Marketing Autopilot");
  for (const bytes of images) {
    const img = isJpeg(bytes) ? await doc.embedJpg(bytes) : isPng(bytes) ? await doc.embedPng(bytes) : null;
    if (!img) throw new Error("Slides must be JPEG or PNG");
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return doc.save();
}

export async function buildLinkedInPdf(imagePaths: readonly string[], opts: { title?: string } = {}): Promise<Uint8Array> {
  const images = await Promise.all(imagePaths.map((p) => readFile(p)));
  return buildLinkedInPdfFromImages(images.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)), opts);
}
