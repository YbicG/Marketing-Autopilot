import { env } from "@mkt/core/config";
import { storage } from "@mkt/core/media";
import { postDownloadFiles, zipStore } from "@mkt/core/publishing";
import { getDb } from "@/lib/db";
import { json, sessionFromRequest } from "@/lib/session";
import { UUID } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fileHeaders(name: string, type: string, size: number): Record<string, string> {
  return {
    "content-type": type,
    "content-length": String(size),
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
}

/**
 * "Download & post yourself": the platform-ready file, or a zip of all of them plus the caption as
 * caption.txt. Workspace-checked; storage keys never leave the server.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json(404, { error: "Post not found." });
  const found = await postDownloadFiles(getDb(), s.workspaceId, id);
  if (!found) return json(404, { error: "Post not found." });
  if (!found.files.length) return json(404, { error: "This post has no files. Copy the caption instead." });

  const store = storage(env());
  let bodies: Buffer[];
  try {
    bodies = await Promise.all(found.files.map((f) => store.get(f.storageKey)));
  } catch {
    return json(404, { error: "A file for this post is missing. Make it again, then download." });
  }
  if (found.files.length === 1) {
    const f = found.files[0]!;
    const b = bodies[0]!;
    return new Response(new Uint8Array(b), { headers: fileHeaders(f.name, f.mime, b.byteLength) });
  }
  const t = found.text;
  const caption = [t?.title, t?.text, ...(t?.parts?.slice(1) ?? [])].filter(Boolean).join("\n\n");
  const zip = zipStore([
    ...found.files.map((f, i) => ({ name: f.name, data: new Uint8Array(bodies[i]!) })),
    ...(caption ? [{ name: "caption.txt", data: new TextEncoder().encode(caption) }] : []),
  ]);
  return new Response(new Uint8Array(zip), { headers: fileHeaders(`${found.post.platform}-post.zip`, "application/zip", zip.byteLength) });
}
