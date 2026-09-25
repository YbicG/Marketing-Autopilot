import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { r2Client, r2Storage } from "./r2.ts";
import { fsStorage, storage } from "./storage.ts";

/** A fake S3 that keeps objects in a Map and records every command. */
function mockS3(pageSize = 2) {
  const objects = new Map<string, { body: Uint8Array; type?: string; at: Date }>();
  const sent: string[] = [];
  const client: Pick<S3Client, "send"> = {
    send: (async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      const input = cmd.input;
      sent.push(`${name}:${String(input.Key ?? input.Prefix ?? "")}`);
      const key = input.Key as string;
      if (name === "PutObjectCommand") {
        objects.set(key, { body: input.Body as Uint8Array, type: input.ContentType as string | undefined, at: new Date(1000) });
        return {};
      }
      if (name === "GetObjectCommand" || name === "HeadObjectCommand") {
        const o = objects.get(key);
        if (!o) throw Object.assign(new Error("missing"), { name: name === "GetObjectCommand" ? "NoSuchKey" : "NotFound", $metadata: { httpStatusCode: 404 } });
        if (name === "HeadObjectCommand") return { ContentLength: o.body.byteLength, LastModified: o.at, ContentType: o.type };
        return { Body: { transformToByteArray: async () => o.body } };
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      if (name === "ListObjectsV2Command") {
        const all = [...objects.keys()].filter((k) => k.startsWith(input.Prefix as string)).sort();
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const page = all.slice(start, start + pageSize);
        const more = start + pageSize < all.length;
        return {
          Contents: page.map((k) => ({ Key: k, Size: objects.get(k)!.body.byteLength, LastModified: objects.get(k)!.at })),
          IsTruncated: more,
          NextContinuationToken: more ? String(start + pageSize) : undefined,
        };
      }
      throw new Error(`unexpected ${name}`);
    }) as unknown as S3Client["send"],
  };
  return { client, objects, sent };
}

const cfg = { accountId: "acc123", accessKeyId: "AKIA", secretAccessKey: "secret", bucket: "mkt-private" };

describe("r2 storage (mock client)", () => {
  it("put / get / head / delete with the right bucket", async () => {
    const m = mockS3();
    const s = r2Storage({ ...cfg, client: m.client });
    await s.put("ws/a/assets/x.png", new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    expect([...(await s.get("ws/a/assets/x.png"))]).toEqual([1, 2, 3]);
    expect(await s.head("ws/a/assets/x.png")).toEqual({ size: 3, lastModified: new Date(1000), contentType: "image/png" });
    await s.delete("ws/a/assets/x.png");
    expect(await s.head("ws/a/assets/x.png")).toBeNull();
    await expect(s.get("ws/a/assets/x.png")).rejects.toThrow(/not found/);
    await expect(s.put("../x", new Uint8Array())).rejects.toThrow(/invalid storage key/);
  });

  it("lists across pages", async () => {
    const m = mockS3(2);
    const s = r2Storage({ ...cfg, client: m.client });
    for (const d of ["01", "02", "03", "04", "05"]) await s.put(`backups/pg/2026-10-${d}.dump`, new Uint8Array([1]));
    await s.put("ws/a/tmp/x", new Uint8Array([1]));
    const list = await s.list("backups/pg/");
    expect(list.map((o) => o.key)).toHaveLength(5);
    expect(m.sent.filter((c) => c.startsWith("ListObjectsV2Command"))).toHaveLength(3);
  });

  it("presigns against the account endpoint", async () => {
    const s = r2Storage({ ...cfg, client: r2Client(cfg) });
    const get = new URL(await s.presignGet!("ws/a/assets/x.png", 600));
    expect(get.host).toBe("acc123.r2.cloudflarestorage.com");
    expect(get.pathname).toBe("/mkt-private/ws/a/assets/x.png");
    expect(get.searchParams.get("X-Amz-Expires")).toBe("600");
    const put = new URL(await s.presignPut!("ws/a/uploads/y.mp4", 300, "video/mp4"));
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toContain("host");
    await expect(s.presignGet!("ws/a/x", 0)).rejects.toThrow(/ttl/);
    await expect(r2Storage({ ...cfg, client: mockS3().client }).presignGet!("ws/a/x", 60)).rejects.toThrow(/real S3 client/);
  });

  it("uses the SDK commands we expect", () => {
    expect(new PutObjectCommand({ Bucket: "b", Key: "k" }).constructor.name).toBe("PutObjectCommand");
    expect(GetObjectCommand.name && HeadObjectCommand.name && ListObjectsV2Command.name).toBeTruthy();
  });
});

describe("storage() driver selection", () => {
  it("r2 without its env gives a plain message", () => {
    expect(() => storage({ STORAGE_DRIVER: "r2", FS_ROOT: "/tmp", R2_BUCKET: "mkt-private" })).toThrow(
      "STORAGE_DRIVER=r2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in the environment",
    );
  });
});

describe("fs list / head", () => {
  let dir: string;
  afterAll(() => rm(dir, { recursive: true, force: true }));
  it("lists by prefix and heads", async () => {
    dir = await mkdtemp(join(tmpdir(), "mkt-list-"));
    const s = fsStorage(dir);
    expect(await s.list("backups/")).toEqual([]);
    await s.put("backups/pg/2026-10-01.dump", new Uint8Array([1, 2]));
    await s.put("ws/a/tmp/x.bin", new Uint8Array([1]));
    const list = await s.list("backups/pg/");
    expect(list.map((o) => [o.key, o.size])).toEqual([["backups/pg/2026-10-01.dump", 2]]);
    expect((await s.head("ws/a/tmp/x.bin"))?.size).toBe(1);
    expect(await s.head("ws/a/tmp/none")).toBeNull();
  });
});
