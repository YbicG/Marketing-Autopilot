import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { r2Storage } from "./r2.ts";

/**
 * D6: object storage. `fs` on the Dokploy volume (/data) until R2 arrives in M2; both drivers
 * share this interface. Keys are opaque, lowercase paths like `ws/<wsId>/assets/<sha>.png`.
 */
export interface Storage {
  put(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Short-lived signed URLs; R2 only (fs has no URL of its own). */
  presignGet?(key: string, ttlSeconds: number): Promise<string>;
  presignPut?(key: string, ttlSeconds: number, contentType: string): Promise<string>;
}

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

/** What both real drivers offer; maint jobs (backups, GC) need listing. */
export interface ListingStorage extends Storage {
  /** Every object whose key starts with `prefix` (a plain string prefix, e.g. "backups/pg/"). */
  list(prefix: string): Promise<StoredObject[]>;
  head(key: string): Promise<{ size: number; lastModified: Date; contentType?: string } | null>;
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,400}$/;

export function assertKey(key: string): void {
  if (!KEY.test(key) || key.includes("..") || key.includes("//") || key.endsWith("/")) {
    throw new Error(`invalid storage key: ${key}`);
  }
}

export function fsStorage(root: string): ListingStorage {
  const base = resolve(root, "objects");
  const pathFor = (key: string) => {
    assertKey(key);
    const p = resolve(join(base, key));
    if (!p.startsWith(base + sep)) throw new Error(`storage key escapes root: ${key}`);
    return p;
  };
  return {
    async put(key, body) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      // Write-then-rename so a reader never sees half a file.
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, p);
    },
    async get(key) {
      return readFile(pathFor(key));
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      let entries: string[];
      try {
        entries = await readdir(base, { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      for (const rel of entries) {
        const key = rel.split(sep).join("/");
        if (!key.startsWith(prefix) || key.endsWith(".tmp")) continue;
        const st = await stat(join(base, rel)).catch(() => null);
        if (st?.isFile()) out.push({ key, size: st.size, lastModified: st.mtime });
      }
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },
    async head(key) {
      const st = await stat(pathFor(key)).catch(() => null);
      if (!st?.isFile()) return null;
      return { size: st.size, lastModified: st.mtime };
    },
  };
}

export interface StorageConfig {
  STORAGE_DRIVER: string;
  FS_ROOT: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
}

let cached: ListingStorage | undefined;

/** The configured driver: `fs` on the Dokploy volume, or R2 `mkt-private` from M2 (D6). */
export function storage(cfg: StorageConfig): ListingStorage {
  if (cached) return cached;
  if (cfg.STORAGE_DRIVER === "fs") {
    cached = fsStorage(cfg.FS_ROOT);
  } else if (cfg.STORAGE_DRIVER === "r2") {
    const missing = (["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const).filter((k) => !cfg[k]);
    if (missing.length) throw new Error(`STORAGE_DRIVER=r2 needs ${missing.join(", ")} in the environment`);
    cached = r2Storage({
      accountId: cfg.R2_ACCOUNT_ID!,
      accessKeyId: cfg.R2_ACCESS_KEY_ID!,
      secretAccessKey: cfg.R2_SECRET_ACCESS_KEY!,
      bucket: cfg.R2_BUCKET!,
    });
  } else {
    throw new Error(`unknown STORAGE_DRIVER ${cfg.STORAGE_DRIVER}`);
  }
  return cached;
}

export function sha256(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function workspacePrefix(workspaceId: string): string {
  return `ws/${workspaceId.toLowerCase()}`;
}
