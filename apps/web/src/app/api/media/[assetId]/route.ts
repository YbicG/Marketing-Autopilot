import { env } from "@mkt/core/config";
import { storage } from "@mkt/core/media";
import { getDb } from "@/lib/db";
import { json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Types safe to render inline (no SVG/HTML: those could script our origin). Everything else is a download. */
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|aac|ogg))$/;
const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
  "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "application/pdf": "pdf",
};

/**
 * Serves one asset by id, scoped to the caller's workspace. `?v=preview` serves the small JPEG
 * preview when there is one; `?dl=1` asks for a download. Supports single Range requests so
 * <video> can seek. Never serves by raw storage key.
 */
export async function GET(req: Request, ctx: { params: Promise<{ assetId: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { assetId } = await ctx.params;
  if (!UUID.test(assetId)) return json(404, { error: "Not found." });

  const asset = await getDb().query.assets.findFirst({
    where: (a, { and, eq }) => and(eq(a.id, assetId), eq(a.workspaceId, s.workspaceId)),
  });
  if (!asset) return json(404, { error: "Not found." });

  const wantPreview = new URL(req.url).searchParams.get("v") === "preview";
  const previewKey = typeof asset.origination.previewKey === "string" ? asset.origination.previewKey : null;
  const key = wantPreview && previewKey ? previewKey : asset.storageKey;
  const realMime = wantPreview && previewKey ? "image/jpeg" : asset.mime;
  const inline = INLINE_MIME.test(realMime);
  const download = new URL(req.url).searchParams.get("dl") === "1" || !inline;
  // Only known-safe types keep their real type; anything else (incl. PDFs) is served as bytes to download.
  const mime = inline || realMime === "application/pdf" ? realMime : "application/octet-stream";
  const filename = `${asset.kind}-${asset.id.slice(0, 8)}.${EXT[realMime] ?? "bin"}`;

  let body: Buffer;
  try {
    body = await storage(env()).get(key);
  } catch {
    return json(404, { error: "Not found." });
  }
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "content-disposition": download ? `attachment; filename="${filename}"` : "inline",
  };

  const range = parseRange(req.headers.get("range"), body.byteLength);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${body.byteLength}` } });
  }
  if (range) {
    const [start, end] = range;
    return new Response(new Uint8Array(body.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${body.byteLength}` },
    });
  }
  return new Response(new Uint8Array(body), { headers: { ...headers, "content-length": String(body.byteLength) } });
}

/** One `bytes=a-b` / `bytes=a-` / `bytes=-n` range → inclusive [start, end]; null = whole body. */
function parseRange(header: string | null, size: number): [number, number] | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null; // multi-range or odd syntax: just send everything
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "invalid";
  return [start, end];
}
