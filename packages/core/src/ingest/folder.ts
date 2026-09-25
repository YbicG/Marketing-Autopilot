import { FolderManifest, gitRemoteFromConfig, isCredentialContent } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { sha256, workspacePrefix, type Storage } from "../media/storage.ts";
import { looksLikeCredentialFile, scanSecrets } from "../security/secret-scan.ts";

export interface StoredFolderFile {
  path: string;
  kind: string;
  size: number;
  storageKey: string;
  secretHits: number;
}

export interface FolderUploadResult {
  id: string;
  files: StoredFolderFile[];
  rejected: { path: string; reason: string }[];
  secretHits: number;
  gitRemote: string | null;
}

export class InvalidUpload extends Error {
  readonly code = "invalid_upload";
  constructor(message: string) {
    super(message);
    this.name = "InvalidUpload";
  }
}

const IMAGE_MAGIC: [string, (b: Uint8Array) => boolean][] = [
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ["image/webp", (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
];

export function sniffImage(body: Uint8Array): string | null {
  return IMAGE_MAGIC.find(([, test]) => body.length > 12 && test(body))?.[0] ?? null;
}

/**
 * Server half of the folder drop (§5.2 step 2). The manifest is re-validated with the same rules the
 * browser used; each text file is checked for credential content and secret-scanned **in memory**,
 * and only the redacted text is stored. `.git/config` is never stored: only its remote URL is kept.
 */
export async function processFolderUpload(
  db: Db,
  store: Storage,
  workspaceId: string,
  rawManifest: unknown,
  bodies: ReadonlyMap<string, Uint8Array>,
): Promise<FolderUploadResult> {
  const parsed = FolderManifest.safeParse(rawManifest);
  if (!parsed.success) throw new InvalidUpload("That folder list didn't pass our checks. Drop the folder again.");
  const manifest = parsed.data;

  const listed = new Set(manifest.files.map((f) => f.path));
  for (const path of bodies.keys()) {
    if (!listed.has(path)) throw new InvalidUpload("The upload had a file that wasn't in the list.");
  }

  const id = uuidv7();
  const prefix = `${workspacePrefix(workspaceId)}/uploads/${id}`;
  const files: StoredFolderFile[] = [];
  const rejected: FolderUploadResult["rejected"] = [];
  let secretHits = 0;
  let gitRemote: string | null = null;

  let n = 0;
  for (const f of manifest.files) {
    const body = bodies.get(f.path);
    if (!body) {
      rejected.push({ path: f.path, reason: "missing" });
      continue;
    }
    if (body.byteLength !== f.size) {
      rejected.push({ path: f.path, reason: "size_mismatch" });
      continue;
    }
    n++;
    if (f.kind === "git_config") {
      gitRemote = gitRemoteFromConfig(new TextDecoder().decode(body));
      continue;
    }
    if (f.kind === "image") {
      const mime = sniffImage(body);
      if (!mime) {
        rejected.push({ path: f.path, reason: "not_an_image" });
        continue;
      }
      const key = `${prefix}/${String(n).padStart(3, "0")}-${sha256(body).slice(0, 16)}.${mime.split("/")[1]}`;
      await store.put(key, body);
      files.push({ path: f.path, kind: f.kind, size: f.size, storageKey: key, secretHits: 0 });
      continue;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    if (isCredentialContent(text) || looksLikeCredentialFile(f.path, text)) {
      rejected.push({ path: f.path, reason: "credential_content" });
      continue;
    }
    const scanned = scanSecrets(text);
    secretHits += scanned.hits.length;
    const key = `${prefix}/${String(n).padStart(3, "0")}.txt`;
    await store.put(key, new TextEncoder().encode(scanned.redacted));
    files.push({ path: f.path, kind: f.kind, size: f.size, storageKey: key, secretHits: scanned.hits.length });
  }

  await db.insert(schema.folderUploads).values({
    id,
    workspaceId,
    rootName: manifest.rootName.slice(0, 255),
    files,
    gitRemote,
    secretHits,
  });
  return { id, files, rejected, secretHits, gitRemote };
}
