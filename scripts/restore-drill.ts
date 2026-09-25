/**
 * Restore drill (§3.5): proves last night's backup can actually come back.
 *
 *   1. (default) takes a fresh backup with the same code as maint.pg_backup, so row counts match;
 *      `--latest` skips this and restores whatever the newest stored dump is.
 *   2. downloads the newest backups/pg/<day>.dump from storage (R2 or fs, per STORAGE_DRIVER),
 *   3. pg_restore's it into the scratch database RESTORE_DATABASE_URL (dropped objects first),
 *   4. compares exact row counts of every table in `public` (+ drizzle's migrations table),
 *      prints them, and exits 1 on any difference.
 *
 * Run in the worker container (it has pg_dump/pg_restore/psql 18 and the repo):
 *   RESTORE_DATABASE_URL=postgres://mkt:…@postgres:5432/mkt_restore pnpm exec tsx scripts/restore-drill.ts
 * The scratch database must already exist and must not be DATABASE_URL.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storage } from "../packages/core/src/media/storage.ts";
import { BACKUP_PREFIX, latestBackupKey, pgBackup, runCommand } from "../apps/worker/src/jobs/maint/pg-backup.ts";

const COUNT_SQL = `
select table_schema || '.' || table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_type = 'BASE TABLE' and table_schema in ('public', 'drizzle')
order by 1`;

function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

async function rowCounts(url: string): Promise<Map<string, number>> {
  const out = await capture("psql", ["--no-psqlrc", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", `--dbname=${url}`, "-c", COUNT_SQL]);
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const [table, n] = line.trim().split("\t");
    if (table && n !== undefined) counts.set(table, Number(n));
  }
  return counts;
}

export interface CountRow {
  table: string;
  source: number | null;
  restored: number | null;
  ok: boolean;
}

export function compareCounts(source: Map<string, number>, restored: Map<string, number>): CountRow[] {
  const tables = [...new Set([...source.keys(), ...restored.keys()])].sort();
  return tables.map((table) => {
    const s = source.get(table) ?? null;
    const r = restored.get(table) ?? null;
    return { table, source: s, restored: r, ok: s !== null && s === r };
  });
}

async function main() {
  const sourceUrl = process.env.DATABASE_URL;
  const scratchUrl = process.env.RESTORE_DATABASE_URL;
  if (!sourceUrl || !scratchUrl) throw new Error("Set DATABASE_URL and RESTORE_DATABASE_URL (a scratch database that already exists).");
  if (new URL(sourceUrl).pathname === new URL(scratchUrl).pathname && new URL(sourceUrl).host === new URL(scratchUrl).host) {
    throw new Error("RESTORE_DATABASE_URL points at the live database. Use a scratch database.");
  }
  const store = storage({
    STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? "fs",
    FS_ROOT: process.env.FS_ROOT ?? "./data",
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET ?? "mkt-private",
  });

  if (!process.argv.includes("--latest")) {
    console.log("Taking a fresh backup…");
    await pgBackup({ storage: store, databaseUrl: sourceUrl, log: () => undefined }, {});
  }
  const key = latestBackupKey((await store.list(BACKUP_PREFIX)).map((o) => o.key));
  if (!key) throw new Error(`No backups under ${BACKUP_PREFIX}`);
  console.log(`Restoring ${key} into the scratch database…`);

  const dir = await mkdtemp(join(tmpdir(), "mkt-restore-"));
  try {
    const file = join(dir, "db.dump");
    await writeFile(file, await store.get(key));
    await runCommand("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", `--dbname=${scratchUrl}`, file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const rows = compareCounts(await rowCounts(sourceUrl), await rowCounts(scratchUrl));
  const width = Math.max(5, ...rows.map((r) => r.table.length));
  console.log(`\n${"table".padEnd(width)}  ${"source".padStart(10)}  ${"restored".padStart(10)}`);
  for (const r of rows) {
    console.log(`${r.table.padEnd(width)}  ${String(r.source ?? "—").padStart(10)}  ${String(r.restored ?? "—").padStart(10)}${r.ok ? "" : "  MISMATCH"}`);
  }
  const bad = rows.filter((r) => !r.ok);
  if (bad.length) {
    console.error(`\nRestore drill FAILED: ${bad.length} of ${rows.length} tables differ (writes since the dump also show up here; rerun without --latest).`);
    process.exit(1);
  }
  console.log(`\nRestore drill passed: ${rows.length} tables, ${key}.`);
}

main().catch((err: Error) => {
  console.error(`Restore drill FAILED: ${err.message}`);
  process.exit(1);
});
