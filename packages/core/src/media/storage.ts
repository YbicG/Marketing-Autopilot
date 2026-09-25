import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * D6: object storage. `fs` on the Dokploy volume (/data) until R2 arrives in M2; both drivers
 * share this interface. Keys are opaque, lowercase paths like `ws/<wsId>/assets/<sha>.png`.
 */
export interface Storage {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,400}$/;

export function assertKey(key: string): void {
  if (!KEY.test(key) || key.includes("..") || key.includes("//") || key.endsWith("/")) {
    throw new Error(`invalid storage key: ${key}`);
  }
}

export function fsStorage(root: string): Storage {
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
  };
}

let cached: Storage | undefined;

/** The configured driver. Only `fs` exists before M2. */
export function storage(cfg: { STORAGE_DRIVER: string; FS_ROOT: string }): Storage {
  if (cfg.STORAGE_DRIVER !== "fs") throw new Error(`storage driver ${cfg.STORAGE_DRIVER} arrives in M2`);
  cached ??= fsStorage(cfg.FS_ROOT);
  return cached;
}

export function sha256(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function workspacePrefix(workspaceId: string): string {
  return `ws/${workspaceId.toLowerCase()}`;
}
