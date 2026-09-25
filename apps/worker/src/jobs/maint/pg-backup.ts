import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListingStorage } from "@mkt/core/media";
import type { MaintJobs } from "@mkt/core/queue";

/**
 * maint.pg_backup (§3.5): nightly `pg_dump --format=custom` to storage at
 * `backups/pg/<YYYY-MM-DD>.dump`, keeping 14 days. Custom format is already compressed and is
 * what pg_restore (scripts/restore-drill.ts) reads. pg_dump is postgresql-client-18 in the worker
 * image, matching the postgres:18 server.
 */
export const BACKUP_PREFIX = "backups/pg/";
export const BACKUP_RETENTION_DAYS = 14;
const KEY_RE = /^backups\/pg\/(\d{4}-\d{2}-\d{2})\.dump$/;

export type RunCommand = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>;

export interface PgBackupDeps {
  storage: ListingStorage;
  databaseUrl: string;
  pgDumpPath?: string;
  now?: () => Date;
  run?: RunCommand;
  tmpDir?: string;
  retentionDays?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export function backupKey(d: Date): string {
  return `${BACKUP_PREFIX}${d.toISOString().slice(0, 10)}.dump`;
}

/** Backup keys whose date is more than `days` before `now` (by UTC day). Other keys are never touched. */
export function expiredBackups(keys: string[], now: Date, days = BACKUP_RETENTION_DAYS): string[] {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86_400_000);
  return keys.filter((k) => {
    const m = KEY_RE.exec(k);
    return m ? new Date(`${m[1]}T00:00:00Z`) < cutoff : false;
  });
}

export function latestBackupKey(keys: string[]): string | undefined {
  return keys.filter((k) => KEY_RE.test(k)).sort().at(-1);
}

/** Runs a command, streaming stderr to the log; rejects on a non-zero exit. */
export const runCommand: RunCommand = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "pipe"], env: env ?? process.env });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))));
  });

/** Custom-format dumps start with "PGDMP"; anything else means pg_dump wrote garbage. */
export function isCustomDump(bytes: Uint8Array): boolean {
  return bytes.length > 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "PGDMP";
}

export async function pgBackup(deps: PgBackupDeps, _data: MaintJobs["maint.pg_backup"]): Promise<{ key: string; bytes: number; deleted: string[] }> {
  const now = deps.now?.() ?? new Date();
  const run = deps.run ?? runCommand;
  const log = deps.log ?? ((m, e) => console.log(m, e ?? ""));
  const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "mkt-pgdump-"));
  const file = join(dir, "db.dump");
  try {
    await run(deps.pgDumpPath ?? "pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--file=${file}`, `--dbname=${deps.databaseUrl}`]);
    // Read into memory: fine at M2 sizes; switch Storage to a streaming put if dumps pass ~500 MB.
    const body = await readFile(file);
    if (!isCustomDump(body)) throw new Error("pg_dump produced something that isn't a custom-format dump");
    const key = backupKey(now);
    await deps.storage.put(key, body, { contentType: "application/octet-stream" });

    const existing = (await deps.storage.list(BACKUP_PREFIX)).map((o) => o.key);
    const deleted = expiredBackups(existing, now, deps.retentionDays);
    for (const k of deleted) await deps.storage.delete(k);
    log("[worker] pg backup stored", { key, bytes: body.byteLength, deleted: deleted.length });
    return { key, bytes: body.byteLength, deleted };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
