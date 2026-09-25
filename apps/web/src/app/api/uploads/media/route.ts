import { env } from "@mkt/core/config";
import { productBySlug } from "@mkt/core/ingest";
import { storage } from "@mkt/core/media";
import { ingestUpload, UPLOAD_CAPS, UploadRejected } from "@mkt/core/video";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { webRenderer } from "@/app/api/videos/_lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MB = 1024 * 1024;
/** The biggest file we take (a recording) plus multipart overhead. */
const MAX_BODY_BYTES = UPLOAD_CAPS.recording + MB;
const TOO_BIG = `That file is over ${Math.round(UPLOAD_CAPS.recording / MB)} MB. Trim the recording or export it at 1080p, then try again.`;

/** Reads a raw body up to `max` bytes; null when it's bigger. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * Footage upload (§2.3 asset picker, /p/[slug]/assets): one screenshot or screen recording.
 * Either multipart (`file` + `slug`) or a raw body with `?slug=&filename=`. The server sniffs the
 * bytes; the browser's type and name are never trusted. Stored as uploaded footage (tier A).
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return json(413, { error: TOO_BIG });

  const url = new URL(req.url);
  let slug = url.searchParams.get("slug") ?? "";
  let filename = url.searchParams.get("filename") ?? "upload";
  let pageUrl: string | null = null;
  let bytes: Uint8Array;

  if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json(400, { error: "We couldn't read that upload. Pick the file again." });
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return json(400, { error: "Pick a screenshot or screen recording to upload." });
    if (file.size > UPLOAD_CAPS.recording) return json(413, { error: TOO_BIG });
    const formSlug = form.get("slug");
    if (typeof formSlug === "string") slug = formSlug;
    const page = form.get("pageUrl");
    if (typeof page === "string" && page.trim()) pageUrl = page.trim().slice(0, 500);
    filename = file.name || filename;
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    const raw = await readCapped(req, UPLOAD_CAPS.recording);
    if (!raw) return json(413, { error: TOO_BIG });
    bytes = raw;
  }
  if (!bytes.byteLength) return json(400, { error: "That file is empty. Pick another one." });

  const db = getDb();
  const product = slug ? await productBySlug(db, s.workspaceId, slug) : null;
  if (!product) return json(404, { error: "Project not found. Refresh the page and try again." });

  try {
    const out = await ingestUpload(
      { db, storage: storage(env()), renderer: webRenderer },
      { workspaceId: s.workspaceId, productId: product.id, bytes, filename: filename.slice(0, 200), pageUrl },
    );
    return json(out.created ? 201 : 200, out);
  } catch (err) {
    if (err instanceof UploadRejected) return json(400, { error: err.message });
    console.error("[media upload]", err);
    return json(500, { error: "That upload didn't work. Try again in a minute." });
  }
}
