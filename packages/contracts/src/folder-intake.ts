import { z } from "zod";

/**
 * Folder intake rules (§2.3 / §5.2). The browser walks a dropped project folder and only files that
 * pass these rules ever leave it. The server re-validates the same rules via `FolderManifest`.
 *
 * All paths are relative to the dropped root (root folder name already stripped), forward slashes.
 */

export const FOLDER_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxFiles: 200,
} as const satisfies { maxFileBytes: number; maxTotalBytes: number; maxFiles: number };

export const INTAKE_KINDS = ["readme", "doc", "package_json", "app_json", "git_config", "image"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export type SkipReason = "denied" | "not_allowlisted" | "too_large" | "over_total" | "credential_content";

export type IntakeDecision =
  | { path: string; include: true; kind: IntakeKind; priority: number }
  | { path: string; include: false; reason: SkipReason };

/** Lower number = kept first when the total limit is hit. */
export const INTAKE_PRIORITY = {
  readme: 1,
  manifest: 2, // package.json / app.json / app.config.json / manifest.json
  git_config: 3,
  top_md: 4,
  docs_md: 5,
  image: 6,
} as const;

const DENIED_DIRS = new Set(["node_modules", "dist", "build", ".next", "out", "coverage", ".turbo", "vendor", ".venv"]);
const DENIED_EXTS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".sqlite", ".db"];
const DENIED_PREFIXES = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials", "secrets"];
/** Other ssh-style key names: id_<something> with no extension, or .pub. */
const ID_KEY_RE = /^id_[a-z0-9_-]+(\.pub)?$/;

const IMAGE_ROOTS = new Set(["public", "screenshots", "assets", "docs"]);
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/;
const MD_EXT_RE = /\.mdx?$/;
const DOCS_MAX_DEPTH = 3; // levels under docs/, counting the file
const IMAGE_MAX_DEPTH = 4; // levels under the image root, counting the file
const ROOT_APP_JSON = new Set(["app.json", "app.config.json", "manifest.json"]);

/** Normalize to forward slashes, drop leading "./" and "/", collapse empty segments. */
export function normalizeIntakePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

/** Remove the dropped root folder's name from the front of a path (e.g. webkitRelativePath). */
export function stripRootName(path: string, rootName: string): string {
  const p = normalizeIntakePath(path);
  const prefix = `${rootName}/`;
  return rootName && p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function isDeniedSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  if (DENIED_DIRS.has(s)) return true;
  if (DENIED_PREFIXES.some((p) => s.startsWith(p))) return true;
  if (DENIED_EXTS.some((e) => s.endsWith(e))) return true;
  return ID_KEY_RE.test(s);
}

function hasUnsafeSegment(segs: string[]): boolean {
  return segs.some((s) => s === "..");
}

/** Path-only allowlist check. Returns the kind + priority, or null if not allowlisted. */
function allowlistKind(segs: string[]): { kind: IntakeKind; priority: number } | null {
  const lower = segs.map((s) => s.toLowerCase());
  const name = lower[lower.length - 1] ?? "";
  const top = lower[0] ?? "";

  if (lower.length === 1) {
    if (name.startsWith("readme")) return { kind: "readme", priority: INTAKE_PRIORITY.readme };
    if (name === "package.json") return { kind: "package_json", priority: INTAKE_PRIORITY.manifest };
    if (ROOT_APP_JSON.has(name)) return { kind: "app_json", priority: INTAKE_PRIORITY.manifest };
    if (MD_EXT_RE.test(name)) return { kind: "doc", priority: INTAKE_PRIORITY.top_md };
    return null;
  }
  if (lower.length === 2 && top === ".git" && name === "config") {
    return { kind: "git_config", priority: INTAKE_PRIORITY.git_config };
  }
  const depthUnderTop = lower.length - 1;
  if (top === "docs" && MD_EXT_RE.test(name) && depthUnderTop <= DOCS_MAX_DEPTH) {
    return { kind: "doc", priority: INTAKE_PRIORITY.docs_md };
  }
  if (IMAGE_ROOTS.has(top) && IMAGE_EXT_RE.test(name) && depthUnderTop <= IMAGE_MAX_DEPTH) {
    return { kind: "image", priority: INTAKE_PRIORITY.image };
  }
  return null;
}

/** Classify one file by path and size. Denylist wins over allowlist; size is checked last. */
export function classifyIntakePath(path: string, sizeBytes: number): IntakeDecision {
  const p = normalizeIntakePath(path);
  const segs = p.split("/").filter(Boolean);
  if (segs.length === 0 || hasUnsafeSegment(segs)) return { path: p, include: false, reason: "not_allowlisted" };
  if (segs.some(isDeniedSegment)) return { path: p, include: false, reason: "denied" };
  const allowed = allowlistKind(segs);
  if (!allowed) return { path: p, include: false, reason: "not_allowlisted" };
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > FOLDER_LIMITS.maxFileBytes) {
    return { path: p, include: false, reason: "too_large" };
  }
  return { path: p, include: true, kind: allowed.kind, priority: allowed.priority };
}

/**
 * Whether a walker should descend into a directory (path relative to root). Lets the browser skip
 * node_modules, .git/objects, src/ etc. without listing them.
 */
export function classifyIntakeDir(dirPath: string): "descend" | "denied" | "not_allowlisted" {
  const segs = normalizeIntakePath(dirPath).split("/").filter(Boolean);
  if (segs.length === 0) return "descend";
  if (hasUnsafeSegment(segs)) return "not_allowlisted";
  if (segs.some(isDeniedSegment)) return "denied";
  const top = (segs[0] ?? "").toLowerCase();
  if (top === ".git") return segs.length === 1 ? "descend" : "not_allowlisted";
  if (top === "docs") return segs.length <= Math.max(DOCS_MAX_DEPTH, IMAGE_MAX_DEPTH) ? "descend" : "not_allowlisted";
  if (IMAGE_ROOTS.has(top)) return segs.length <= IMAGE_MAX_DEPTH ? "descend" : "not_allowlisted";
  return "not_allowlisted";
}

/** True for JSON (or any text) that looks like it carries credentials, e.g. a GCP service-account key. */
export function isCredentialContent(text: string): boolean {
  return (
    /"type"\s*:\s*"service_account"/.test(text) ||
    /"private_key(_id)?"\s*:/.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
  );
}

type Included = IntakeDecision & { include: true; size: number };
type Skipped = IntakeDecision & { include: false };

/**
 * Classify every file, then keep by priority (README > package.json/app.json > .git/config > top-level md
 * > docs md > images) until the total size or file count limit is hit. Everything else is reported.
 */
export function planIntake(files: { path: string; size: number }[]): {
  included: Included[];
  skipped: Skipped[];
  totalBytes: number;
} {
  const skipped: Skipped[] = [];
  const candidates: Included[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const d = classifyIntakePath(f.path, f.size);
    if (!d.include) {
      skipped.push(d);
      continue;
    }
    if (seen.has(d.path)) continue;
    seen.add(d.path);
    candidates.push({ ...d, size: f.size });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));

  const included: Included[] = [];
  let totalBytes = 0;
  for (const c of candidates) {
    if (included.length >= FOLDER_LIMITS.maxFiles || totalBytes + c.size > FOLDER_LIMITS.maxTotalBytes) {
      skipped.push({ path: c.path, include: false, reason: "over_total" });
      continue;
    }
    included.push(c);
    totalBytes += c.size;
  }
  return { included, skipped, totalBytes };
}

/** Pull `url = ...` values out of an INI-ish .git/config, preferring [remote "origin"]. */
function remoteUrlsFromConfig(text: string): string[] {
  const origin: string[] = [];
  const others: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (sec) {
      section = (sec[1] ?? "").replace(/\s+/g, " ");
      continue;
    }
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (!kv || !/^remote\b/i.test(section)) continue;
    const value = (kv[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
    if (/^remote "origin"$/i.test(section)) origin.push(value);
    else others.push(value);
  }
  return [...origin, ...others];
}

function normalizeRemote(url: string): string | null {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url.replace(/^git\+/i, ""));
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp && !/^[a-z]:$/i.test(`${scp[1]}:`)) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    return null; // local path or unknown form
  }
  host = host.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/[?#].*$/, ""));
  if (parts.length === 0) return null;
  const last = parts.length - 1;
  parts[last] = (parts[last] ?? "").replace(/\.git$/i, "");
  if (host === "github.com") {
    const [owner, repo] = parts;
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo}`;
  }
  return `https://${host}/${parts.join("/")}`;
}

/**
 * Remote URL from a .git/config text, normalized to https://github.com/o/r when it's GitHub (handles
 * git@github.com:o/r.git, ssh://, https with .git). Strips any userinfo/token.
 */
export function gitRemoteFromConfig(text: string): string | null {
  for (const url of remoteUrlsFromConfig(text)) {
    const n = normalizeRemote(url);
    if (n) return n;
  }
  return null;
}

/** Upload manifest the server re-validates. Every file must pass the same path/size rules. */
export const FolderManifest = z
  .object({
    rootName: z.string().trim().min(1).max(255),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(1024),
          size: z.number().int().nonnegative().max(FOLDER_LIMITS.maxFileBytes),
          kind: z.enum(INTAKE_KINDS),
        }),
      )
      .max(FOLDER_LIMITS.maxFiles),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    let total = 0;
    m.files.forEach((f, i) => {
      total += f.size;
      const d = classifyIntakePath(f.path, f.size);
      if (d.path !== f.path) {
        ctx.addIssue({ code: "custom", path: ["files", i, "path"], message: "path must be normalized" });
      } else if (!d.include) {
        ctx.addIssue({ code: "custom", path: ["files", i, "path"], message: `file not allowed: ${d.reason}` });
      } else if (d.kind !== f.kind) {
        ctx.addIssue({ code: "custom", path: ["files", i, "kind"], message: `expected kind ${d.kind}` });
      }
      if (seen.has(f.path)) {
        ctx.addIssue({ code: "custom", path: ["files", i, "path"], message: "duplicate path" });
      }
      seen.add(f.path);
    });
    if (total > FOLDER_LIMITS.maxTotalBytes) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "total size over limit" });
    }
  });
export type FolderManifest = z.infer<typeof FolderManifest>;
