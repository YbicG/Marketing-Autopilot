/**
 * Browser-side folder walker (§2.3 / §5.2). Walks a dropped project folder, never descends into
 * node_modules/.git/src etc., and only reads file contents in two cases:
 *   - allowlisted JSON (package.json, app.json, …) to run the credential check
 *   - .git/config, which is replaced by a synthesized file holding only the normalized remote URL
 * Nothing is uploaded here; the parent builds a FormData with `buildFolderFormData`.
 */
import {
  FOLDER_LIMITS,
  FolderManifest,
  classifyIntakeDir,
  classifyIntakePath,
  gitRemoteFromConfig,
  isCredentialContent,
  stripRootName,
  type IntakeDecision,
  type IntakeKind,
} from "@mkt/contracts";

export type WalkedFile = { path: string; file: File };
export type WalkSkipped = IntakeDecision & { include: false };
export type WalkResult = {
  rootName: string;
  /** Files that passed the path rules (and content checks). Run `planIntake` on these for limits. */
  files: WalkedFile[];
  /** Files/folders rejected during the walk. Pruned folders are listed once with a trailing "/". */
  skipped: WalkSkipped[];
};

export type FolderSelection = {
  rootName: string;
  files: { path: string; kind: IntakeKind; file: File | Blob }[];
};

const FALLBACK_ROOT = "selection";

// ---------- FileSystem entry helpers (webkitGetAsEntry API) ----------

function isDirEntry(e: FileSystemEntry): e is FileSystemDirectoryEntry {
  return e.isDirectory;
}
function isFileEntry(e: FileSystemEntry): e is FileSystemFileEntry {
  return e.isFile;
}

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries returns results in batches (~100 in Chrome); keep calling until it returns empty.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// ---------- shared per-file handling ----------

/** Content checks for the two cases where we read a file. Returns the file to keep, or a skip reason. */
async function inspectFile(path: string, file: File): Promise<File | WalkSkipped> {
  const decision = classifyIntakePath(path, file.size);
  if (!decision.include) return decision;

  if (decision.kind === "git_config") {
    const remote = gitRemoteFromConfig(await file.text());
    if (!remote) return { path, include: false, reason: "not_allowlisted" };
    return new File([`[remote "origin"]\n\turl = ${remote}\n`], "config", { type: "text/plain" });
  }
  if (path.toLowerCase().endsWith(".json")) {
    if (isCredentialContent(await file.text())) return { path, include: false, reason: "credential_content" };
  }
  return file;
}

async function addFile(result: WalkResult, path: string, file: File): Promise<void> {
  const out = await inspectFile(path, file);
  if (out instanceof File) result.files.push({ path, file: out });
  else result.skipped.push(out);
}

/** Path-only pre-check so we don't even open File handles for files that can't be included. */
function prefilter(path: string): WalkSkipped | null {
  const d = classifyIntakePath(path, 0);
  return d.include ? null : d;
}

async function walkDir(result: WalkResult, dir: FileSystemDirectoryEntry, prefix: string): Promise<void> {
  const entries = await readAllEntries(dir);
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isDirEntry(entry)) {
      const d = classifyIntakeDir(path);
      if (d === "descend") await walkDir(result, entry, path);
      else result.skipped.push({ path: `${path}/`, include: false, reason: d });
    } else if (isFileEntry(entry)) {
      const pre = prefilter(path);
      if (pre) {
        result.skipped.push(pre);
        continue;
      }
      await addFile(result, path, await entryFile(entry));
    }
  }
}

/**
 * Walk a drop. Call this synchronously from the `drop` handler: entries are captured before the first
 * await, since the DataTransferItemList is emptied once the event returns.
 * A single dropped folder becomes the root (its name is stripped). Plain dropped files are root-level;
 * with a mix, dropped folders keep their name as the first path segment.
 */
export async function walkDroppedItems(items: DataTransferItemList): Promise<WalkResult> {
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }

  const only = entries.length === 1 && looseFiles.length === 0 ? entries[0] : undefined;
  if (only && isDirEntry(only)) {
    const result: WalkResult = { rootName: only.name || FALLBACK_ROOT, files: [], skipped: [] };
    await walkDir(result, only, "");
    return result;
  }

  const result: WalkResult = { rootName: FALLBACK_ROOT, files: [], skipped: [] };
  for (const entry of entries) {
    if (isDirEntry(entry)) {
      const d = classifyIntakeDir(entry.name);
      if (d === "descend") await walkDir(result, entry, entry.name);
      else result.skipped.push({ path: `${entry.name}/`, include: false, reason: d });
    } else if (isFileEntry(entry)) {
      const pre = prefilter(entry.name);
      if (pre) result.skipped.push(pre);
      else await addFile(result, entry.name, await entryFile(entry));
    }
  }
  for (const f of looseFiles) {
    const pre = prefilter(f.name);
    if (pre) result.skipped.push(pre);
    else await addFile(result, f.name, f);
  }
  return result;
}

/**
 * Fallback for `<input type="file" webkitdirectory>`: the browser hands over every file flat with
 * `webkitRelativePath` ("root/sub/file"). Same rules; pruned folders are collapsed into one entry.
 */
export async function walkInputFiles(list: FileList | File[]): Promise<WalkResult> {
  const files = Array.from(list);
  const first = files[0]?.webkitRelativePath || "";
  const rootName = first.includes("/") ? (first.split("/")[0] ?? "") : "";
  const result: WalkResult = { rootName: rootName || FALLBACK_ROOT, files: [], skipped: [] };
  const prunedDirs = new Set<string>();

  for (const f of files) {
    const rel = stripRootName(f.webkitRelativePath || f.name, rootName);
    const segs = rel.split("/");
    // Collapse anything inside a folder we wouldn't have walked into.
    let pruned = false;
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      const d = classifyIntakeDir(dir);
      if (d !== "descend") {
        if (!prunedDirs.has(dir)) {
          prunedDirs.add(dir);
          result.skipped.push({ path: `${dir}/`, include: false, reason: d });
        }
        pruned = true;
        break;
      }
    }
    if (pruned) continue;
    const pre = prefilter(rel);
    if (pre) result.skipped.push(pre);
    else await addFile(result, rel, f);
  }
  return result;
}

/** Multipart body for the upload: `manifest` = FolderManifest JSON, plus one `file:<path>` field per file. */
export function buildFolderFormData(selection: FolderSelection): FormData {
  const manifest = FolderManifest.parse({
    rootName: selection.rootName,
    files: selection.files.map((f) => ({ path: f.path, size: f.file.size, kind: f.kind })),
  });
  const fd = new FormData();
  fd.append("manifest", JSON.stringify(manifest));
  for (const f of selection.files) {
    const name = f.path.split("/").pop() || "file";
    fd.append(`file:${f.path}`, f.file, name);
  }
  return fd;
}

export { FOLDER_LIMITS };
