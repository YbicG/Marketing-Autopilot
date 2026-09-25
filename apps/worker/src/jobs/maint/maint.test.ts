import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fsStorage, type ListingStorage } from "@mkt/core/media";
import type { AccountHealth, PublisherAdapter } from "@mkt/providers";
import { connectionsHealth, patchFor, type ConnectionPatch, type ConnectionRow } from "./connections-health.ts";
import { heartbeat } from "./heartbeat.ts";
import { backupKey, expiredBackups, isCustomDump, latestBackupKey, pgBackup } from "./pg-backup.ts";
import { gcCandidates, storageGc } from "./storage-gc.ts";

let dir: string;
let store: ListingStorage;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mkt-maint-"));
  store = fsStorage(dir);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("pg backup", () => {
  it("keys and retention by UTC day", () => {
    const now = new Date("2026-11-20T03:10:00Z");
    expect(backupKey(now)).toBe("backups/pg/2026-11-20.dump");
    const keys = ["backups/pg/2026-11-05.dump", "backups/pg/2026-11-06.dump", "backups/pg/2026-11-19.dump", "backups/pg/notes.txt"];
    expect(expiredBackups(keys, now)).toEqual(["backups/pg/2026-11-05.dump"]);
    expect(latestBackupKey(keys)).toBe("backups/pg/2026-11-19.dump");
  });

  it("dumps with pg_dump args, stores the file and prunes old dumps", async () => {
    await store.put("backups/pg/2026-10-01.dump", new Uint8Array([1]));
    let args: string[] = [];
    const out = await pgBackup(
      {
        storage: store,
        databaseUrl: "postgres://u:p@postgres:5432/mkt",
        now: () => new Date("2026-11-20T03:10:00Z"),
        tmpDir: dir,
        log: () => undefined,
        run: async (_cmd, a) => {
          args = a;
          const file = a.find((x) => x.startsWith("--file="))!.slice(7);
          await writeFile(file, Buffer.from("PGDMP\x01\x0e\x00rest"));
        },
      },
      {},
    );
    expect(args).toContain("--format=custom");
    expect(args).toContain("--dbname=postgres://u:p@postgres:5432/mkt");
    expect(out).toMatchObject({ key: "backups/pg/2026-11-20.dump", deleted: ["backups/pg/2026-10-01.dump"] });
    expect(isCustomDump(await store.get("backups/pg/2026-11-20.dump"))).toBe(true);
    expect(await store.head("backups/pg/2026-10-01.dump")).toBeNull();
  });

  it("refuses output that isn't a custom dump", async () => {
    await expect(
      pgBackup({ storage: store, databaseUrl: "postgres://x", tmpDir: dir, run: async (_c, a) => writeFile(a.find((x) => x.startsWith("--file="))!.slice(7), "oops") }, {}),
    ).rejects.toThrow(/custom-format/);
  });
});

describe("storage gc", () => {
  it("only deletes old files under ws/<id>/tmp/", async () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const old = new Date("2026-11-01T00:00:00Z");
    expect(
      gcCandidates(
        [
          { key: "ws/abc/tmp/a.bin", size: 1, lastModified: old },
          { key: "ws/abc/tmp/new.bin", size: 1, lastModified: now },
          { key: "ws/abc/assets/a.png", size: 1, lastModified: old },
          { key: "backups/pg/2026-01-01.dump", size: 1, lastModified: old },
        ],
        now,
      ),
    ).toEqual(["ws/abc/tmp/a.bin"]);
    await store.put("ws/abc/tmp/fresh.bin", new Uint8Array([1]));
    expect(await storageGc({ storage: store, log: () => undefined }, {})).toEqual({ deleted: 0 });
  });
});

describe("heartbeat", () => {
  it("pings when configured and never throws", async () => {
    const urls: string[] = [];
    await heartbeat({ pingUrl: "https://hc-ping.com/x", fetch: async (u) => (urls.push(u), new Response("OK")) }, {});
    expect(urls).toEqual(["https://hc-ping.com/x"]);
    await heartbeat({}, {});
    const logs: string[] = [];
    await heartbeat({ pingUrl: "https://hc-ping.com/x", fetch: async () => Promise.reject(new Error("down")), log: (m) => logs.push(m) }, {});
    expect(logs).toEqual(["[worker] heartbeat ping failed"]);
    const hang = (_u: string, i: RequestInit) => new Promise<Response>((_, rej) => i.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    await heartbeat({ pingUrl: "https://hc-ping.com/x", fetch: hang, timeoutMs: 10, log: (m) => logs.push(m) }, {});
    expect(logs).toHaveLength(2);
  });
});

describe("connections health", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  const conn = (id: string, platform: string, over: Partial<ConnectionRow> = {}): ConnectionRow => ({
    id,
    workspaceId: "ws1",
    publisher: "upload_post",
    platform,
    profileRef: "syllacal",
    status: "active",
    ...over,
  });

  it("maps health to patches", () => {
    const h: AccountHealth[] = [
      { platform: "tiktok", status: "active", handle: "syllacal", tokenExpiresAt: "2026-12-01T00:00:00Z" },
      { platform: "youtube", status: "active", tokenExpiresAt: "2026-11-01T00:00:00Z" },
    ];
    expect(patchFor(conn("1", "tiktok"), h, now)).toEqual({ status: "active", tokenExpiresAt: new Date("2026-12-01T00:00:00Z"), lastHealthAt: now, handle: "syllacal" });
    expect(patchFor(conn("2", "youtube"), h, now).status).toBe("reauth_required");
    expect(patchFor(conn("3", "instagram"), h, now).status).toBe("reauth_required");
  });

  it("one health call per profile; a failing profile is left alone", async () => {
    const updates: [string, ConnectionPatch][] = [];
    let calls = 0;
    const adapter = {
      health: async (_ctx: unknown, profileRef: string) => {
        calls++;
        if (profileRef === "broken") throw new Error("500");
        return [{ platform: "tiktok", status: "reauth_required" }] as AccountHealth[];
      },
    } as unknown as PublisherAdapter;
    const out = await connectionsHealth(
      {
        store: {
          listChecked: async () => [conn("1", "tiktok"), conn("2", "instagram"), conn("3", "tiktok", { profileRef: "broken" }), conn("4", "x", { status: "revoked" })],
          update: async (_ws, id, patch) => void updates.push([id, patch]),
        },
        adapterFor: (p) => (p === "upload_post" ? adapter : undefined),
        ctxFor: () => ({ secret: async () => "k" }),
        now: () => now,
        log: () => undefined,
      },
      {},
    );
    expect(calls).toBe(2);
    expect(out).toEqual({ checked: 2, reauth: 2, failedProfiles: 1 });
    expect(updates.map(([id, p]) => [id, p.status])).toEqual([
      ["1", "reauth_required"],
      ["2", "reauth_required"],
    ]);
  });
});
