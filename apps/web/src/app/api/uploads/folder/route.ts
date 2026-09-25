import { FOLDER_LIMITS } from "@mkt/contracts";
import { env } from "@mkt/core/config";
import { InvalidUpload, processFolderUpload } from "@mkt/core/ingest";
import { storage } from "@mkt/core/media";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 10 MB of files plus multipart overhead and the manifest. */
const MAX_BODY_BYTES = 11 * 1024 * 1024;
const TOO_BIG = "That folder is over the 10 MB limit. Drop fewer screenshots and try again.";

/**
 * The folder drop's upload (§5.2 step 2): `manifest` (JSON) plus one `file:<path>` field per file.
 * The server re-checks everything in processFolderUpload; nothing here trusts the browser's list.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return json(413, { error: TOO_BIG });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "We couldn't read that upload. Drop the folder again." });
  }

  let manifest: unknown = null;
  const bodies = new Map<string, Uint8Array>();
  let total = 0;
  for (const [name, value] of form.entries()) {
    if (name === "manifest" && typeof value === "string") {
      try {
        manifest = JSON.parse(value);
      } catch {
        return json(400, { error: "That folder list didn't pass our checks. Drop the folder again." });
      }
      continue;
    }
    if (!name.startsWith("file:") || typeof value === "string") continue;
    if (bodies.size >= FOLDER_LIMITS.maxFiles) return json(400, { error: "That's too many files. Drop the folder again." });
    total += value.size;
    if (total > FOLDER_LIMITS.maxTotalBytes) return json(413, { error: TOO_BIG });
    bodies.set(name.slice("file:".length), new Uint8Array(await value.arrayBuffer()));
  }
  if (manifest === null) return json(400, { error: "That folder list was missing. Drop the folder again." });

  try {
    const out = await processFolderUpload(getDb(), storage(env()), s.workspaceId, manifest, bodies);
    return json(201, {
      folderUploadId: out.id,
      files: out.files.length,
      rejected: out.rejected,
      secretHits: out.secretHits,
    });
  } catch (err) {
    if (err instanceof InvalidUpload) return json(400, { error: err.message });
    throw err;
  }
}
