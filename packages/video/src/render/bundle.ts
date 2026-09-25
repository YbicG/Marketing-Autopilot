import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";

// §5.6 step 7: one prebuilt bundle per source hash, reused across renders and restarts.

export const ENTRY = fileURLToPath(new URL("../entry.ts", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));
const PKG_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));

/** Files that end up in the bundle: everything under src except the Node-only renderer and tests. */
export const isBundleSource = (rel: string) => {
  const p = rel.split(sep).join("/");
  return !p.startsWith("render/") && !/\.test\.tsx?$/.test(p);
};

/** Stable hash of (relative path, content) pairs. */
export function sourceHash(files: readonly { path: string; content: Uint8Array | string }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path.split(sep).join("/"));
    h.update("\0");
    h.update(f.content);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export async function currentSourceHash(): Promise<string> {
  const files = (await walk(SRC_DIR)).filter((p) => isBundleSource(relative(SRC_DIR, p)));
  const entries = await Promise.all(files.map(async (p) => ({ path: relative(SRC_DIR, p), content: await readFile(p) })));
  // Dependency versions change the bundle too.
  entries.push({ path: "package.json", content: await readFile(PKG_JSON) });
  return sourceHash(entries);
}

export const bundleCacheRoot = () => process.env.REMOTION_BUNDLE_DIR ?? join(tmpdir(), "mkt-remotion-bundles");

const inflight = new Map<string, Promise<string>>();

/**
 * Bundle dir for the current sources: reused when <root>/<hash>/index.html exists, else built
 * into a temp dir and renamed into place (atomic, so a crash never leaves half a bundle).
 * Webpack's disk cache stays off: node_modules is root-owned in the worker image.
 */
export async function ensureBundle(): Promise<string> {
  const hash = await currentSourceHash();
  const existing = inflight.get(hash);
  if (existing) return existing;
  const p = (async () => {
    const root = bundleCacheRoot();
    const dir = join(root, hash);
    if (existsSync(join(dir, "index.html"))) return dir;
    await mkdir(root, { recursive: true });
    const tmp = join(root, `${hash}.tmp-${process.pid}-${Date.now()}`);
    await bundle({ entryPoint: ENTRY, outDir: tmp, enableCaching: false });
    try {
      await rename(tmp, dir);
    } catch (err) {
      // Another process won the race; use its bundle.
      await rm(tmp, { recursive: true, force: true });
      if (!existsSync(join(dir, "index.html"))) throw err;
    }
    return dir;
  })();
  inflight.set(hash, p);
  p.catch(() => inflight.delete(hash));
  return p;
}

/** @deprecated M0 name; same as ensureBundle. */
export const getBundle = ensureBundle;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function linkOrCopy(src: string, dst: string): Promise<void> {
  try {
    await link(src, dst);
  } catch {
    // Different filesystem (EXDEV) or no hard links: copy instead.
    await copyFile(src, dst);
  }
}

async function mirror(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) await mirror(s, d);
    else if (e.isFile()) await linkOrCopy(s, d);
  }
}

/**
 * A per-render copy of the bundle (hard links, so it's cheap) with this render's assets at
 * public/a/<assetId>, which is where staticFile(`a/${id}`) points. Props never carry paths (D8).
 */
export async function stageBundle(
  bundleDir: string,
  assetFiles: Record<string, string>,
  workDir: string,
): Promise<{ serveUrl: string; cleanup: () => Promise<void> }> {
  const serveUrl = join(workDir, "bundle");
  await mirror(bundleDir, serveUrl);
  const assetDir = join(serveUrl, "public", "a");
  await mkdir(assetDir, { recursive: true });
  for (const [id, path] of Object.entries(assetFiles)) {
    if (!SAFE_ID.test(id)) throw new Error(`Not an asset id: ${id}`);
    await linkOrCopy(path, join(assetDir, id));
  }
  return { serveUrl, cleanup: () => rm(serveUrl, { recursive: true, force: true }) };
}
