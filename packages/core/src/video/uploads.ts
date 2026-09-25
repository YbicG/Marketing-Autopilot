import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@mkt/db";
import { sniffImage } from "../ingest/folder.ts";
import { labelScreenshot, type CallCtx } from "../ingest/steps.ts";
import { scanSecrets } from "../security/secret-scan.ts";
import type { VideoDeps } from "./deps.ts";
import { storeAsset } from "./store.ts";

const { assets } = schema;

/** §2.3 "Add footage": caps per kind. */
export const UPLOAD_CAPS = { image: 20 * 1024 * 1024, recording: 300 * 1024 * 1024 } as const;
/** Screen recordings longer than this are refused (the editor trims; a 30 s video uses seconds of it). */
export const MAX_RECORDING_MS = 10 * 60_000;

export class UploadRejected extends Error {
  readonly code = "upload_rejected";
  constructor(message: string) {
    super(message);
    this.name = "UploadRejected";
  }
}

export interface SniffedMedia {
  kind: "image" | "recording";
  mime: string;
  ext: string;
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** The file's real type from its first bytes; the name and the browser's type are never trusted. */
export function sniffMedia(body: Uint8Array): SniffedMedia | null {
  const img = sniffImage(body);
  if (img) return { kind: "image", mime: img, ext: IMAGE_EXT[img]! };
  if (body.length < 12) return null;
  // ISO BMFF: size(4) "ftyp" brand(4)
  if (body[4] === 0x66 && body[5] === 0x74 && body[6] === 0x79 && body[7] === 0x70) {
    const brand = String.fromCharCode(body[8]!, body[9]!, body[10]!, body[11]!);
    if (brand === "qt  ") return { kind: "recording", mime: "video/quicktime", ext: "mov" };
    if (/^(isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |MSNV|3gp\d)$/.test(brand)) return { kind: "recording", mime: "video/mp4", ext: "mp4" };
    return null;
  }
  // EBML (WebM/Matroska)
  if (body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3) return { kind: "recording", mime: "video/webm", ext: "webm" };
  return null;
}

/** Throws the plain-English refusal the upload form shows. */
export function checkUpload(body: Uint8Array): SniffedMedia {
  const m = sniffMedia(body);
  if (!m) throw new UploadRejected("That file isn't a PNG, JPEG, GIF, WebP, MP4, MOV or WebM. Export it as one of those and try again.");
  const cap = UPLOAD_CAPS[m.kind];
  if (body.byteLength > cap) {
    throw new UploadRejected(`That ${m.kind === "image" ? "image" : "recording"} is ${mb(body.byteLength)} MB; the limit is ${mb(cap)} MB.${m.kind === "recording" ? " Trim it or export at 1080p." : ""}`);
  }
  if (body.byteLength === 0) throw new UploadRejected("That file is empty.");
  return m;
}

const mb = (n: number) => Math.round(n / (1024 * 1024));

export interface UploadInput {
  workspaceId: string;
  productId: string;
  bytes: Uint8Array;
  /** Shown name only; secret-scanned and never used as a path. */
  filename: string;
  /** The page it shows, if the user said (for labels). */
  pageUrl?: string | null;
}

export interface UploadResult {
  assetId: string;
  kind: "image" | "recording";
  created: boolean;
  durationMs: number | null;
  /** Labeling found personal data: the asset is kept but never used in a video until blurred. */
  hasPersonalData: boolean;
}

/**
 * Footage upload (§2.3): sniff, cap, store content-addressed under ws/<id>/assets/<sha>.<ext>
 * (origin uploaded, tier A), probe recordings, label images (ingest.label_asset via the injected
 * resizer). `label` is optional so a bulk import can label later.
 */
export async function ingestUpload(
  deps: Pick<VideoDeps, "db" | "storage" | "renderer" | "imageResizer" | "workDir">,
  input: UploadInput,
  label?: CallCtx,
): Promise<UploadResult> {
  const m = checkUpload(input.bytes);
  const name = scanSecrets(input.filename.slice(0, 200)).redacted;

  let durationMs: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  if (m.kind === "recording") {
    const dir = await mkdtemp(join(deps.workDir ?? tmpdir(), "mkt-upload-"));
    try {
      const p = join(dir, `in.${m.ext}`);
      await writeFile(p, input.bytes);
      const probe = await deps.renderer.ffprobe(p);
      durationMs = probe.durationMs;
      width = probe.video?.width ?? null;
      height = probe.video?.height ?? null;
      if (!probe.video) throw new UploadRejected("That recording has no video track.");
      if (durationMs > MAX_RECORDING_MS) throw new UploadRejected("That recording is longer than 10 minutes. Trim it to the part you want to show.");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const stored = await storeAsset(deps.db, deps.storage, {
    workspaceId: input.workspaceId,
    productId: input.productId,
    kind: m.kind,
    origin: "uploaded",
    tier: "A",
    mime: m.mime,
    ext: m.ext,
    bytes: input.bytes,
    durationMs,
    width,
    height,
    origination: { source: "upload", filename: name },
  });

  let hasPersonalData = false;
  if (m.kind === "image" && label && stored.created && deps.imageResizer) {
    const small = await deps.imageResizer.toJpeg(input.bytes, 1280, 1280, 80);
    const labels = await labelScreenshot(label, { jpeg: small.jpeg, pageUrl: input.pageUrl ?? "(uploaded)", viewport: `${small.srcWidth}x${small.srcHeight}` });
    hasPersonalData = labels.hasPersonalData;
    await deps.db
      .update(assets)
      .set({ labels: labels as unknown as Record<string, unknown>, piiHits: labels.hasPersonalData, width: small.srcWidth, height: small.srcHeight })
      .where(eq(assets.id, stored.id));
  }
  return { assetId: stored.id, kind: m.kind, created: stored.created, durationMs, hasPersonalData };
}
