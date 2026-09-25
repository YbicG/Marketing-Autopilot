import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertKey, fsStorage, sha256, type Storage } from "./storage.ts";

let dir: string;
let s: Storage;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mkt-storage-"));
  s = fsStorage(dir);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("fs storage", () => {
  it("round-trips and deletes", async () => {
    await s.put("ws/abc/assets/x.png", new Uint8Array([1, 2, 3]));
    expect([...(await s.get("ws/abc/assets/x.png"))]).toEqual([1, 2, 3]);
    await s.delete("ws/abc/assets/x.png");
    await expect(s.get("ws/abc/assets/x.png")).rejects.toThrow();
  });

  it("refuses keys that could escape the root", () => {
    for (const bad of ["../etc/passwd", "ws/../../x", "/abs", "ws//x", "Ws/X", "ws/x/", "", "ws\\x"]) {
      expect(() => assertKey(bad), bad).toThrow();
    }
  });

  it("hashes deterministically", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
