import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import {
  decryptSecret,
  deleteSecret,
  encryptSecret,
  envKeyring,
  getSecret,
  listSecrets,
  putSecret,
  resolveSecret,
  secretAad,
  VaultKeyError,
} from "./vault.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const kek1 = randomBytes(32).toString("base64");
const kek2 = randomBytes(32).toString("base64");
const keyring = envKeyring({ MKT_KEK_V1_B64: kek1, MKT_KEK_ACTIVE: "1" });

async function newWorkspace() {
  const id = uuidv7();
  await db.insert(schema.workspaces).values({ id, name: "test" });
  return id;
}

describe("envelope encryption", () => {
  const aad = secretAad("ws1", "upload_post.api_key", "sec1");

  it("round-trips", () => {
    const sealed = encryptSecret("up_live_abcdef123456", aad, keyring);
    expect(sealed.kekVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain("abcdef");
    expect(Buffer.from(sealed.wrappedDek, "base64")).toHaveLength(60);
    expect(decryptSecret(sealed, aad, keyring)).toBe("up_live_abcdef123456");
  });

  it("fails with a different AAD (workspace, purpose or id)", () => {
    const sealed = encryptSecret("v", aad, keyring);
    for (const other of [secretAad("ws2", "upload_post.api_key", "sec1"), secretAad("ws1", "elevenlabs.api_key", "sec1"), secretAad("ws1", "upload_post.api_key", "sec2")]) {
      expect(() => decryptSecret(sealed, other, keyring)).toThrow();
    }
  });

  it("fails on tampered ciphertext, tag or wrapped key", () => {
    const sealed = encryptSecret("some secret value", aad, keyring);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[b.length - 1]! ^= 1;
      return b.toString("base64");
    };
    expect(() => decryptSecret({ ...sealed, ciphertext: flip(sealed.ciphertext) }, aad, keyring)).toThrow();
    expect(() => decryptSecret({ ...sealed, tag: flip(sealed.tag) }, aad, keyring)).toThrow();
    expect(() => decryptSecret({ ...sealed, wrappedDek: flip(sealed.wrappedDek) }, aad, keyring)).toThrow();
  });

  it("throws if the KEK is missing or not 32 bytes", () => {
    expect(() => envKeyring({}).kek(1)).toThrow(VaultKeyError);
    expect(() => envKeyring({ MKT_KEK_V1_B64: randomBytes(16).toString("base64") }).kek(1)).toThrow(/32 bytes/);
    expect(() => encryptSecret("v", aad, envKeyring({}))).toThrow(/MKT_KEK_V1_B64/);
    expect(() => envKeyring({ MKT_KEK_ACTIVE: "0" })).toThrow();
  });

  it("old rows still open after the active KEK moves on", () => {
    const sealed = encryptSecret("v1 secret", aad, keyring);
    const rotated = envKeyring({ MKT_KEK_V1_B64: kek1, MKT_KEK_V2_B64: kek2, MKT_KEK_ACTIVE: "2" });
    expect(decryptSecret(sealed, aad, rotated)).toBe("v1 secret");
    expect(encryptSecret("new", aad, rotated).kekVersion).toBe(2);
  });
});

describe("vault in the database", () => {
  it("put / get / replace / list / delete", async () => {
    const ws = await newWorkspace();
    const first = await putSecret(db, ws, "upload_post.api_key", "up_live_0000000000abcd", keyring);
    expect(first.hint).toBe("abcd");
    expect(await getSecret(db, ws, "upload_post.api_key", keyring)).toBe("up_live_0000000000abcd");

    const second = await putSecret(db, ws, "upload_post.api_key", "up_live_1111111111wxyz", keyring);
    expect(second.id).toBe(first.id);
    expect(await getSecret(db, ws, "upload_post.api_key", keyring)).toBe("up_live_1111111111wxyz");
    await putSecret(db, ws, "short.key", "abc", keyring);

    const list = await listSecrets(db, ws);
    expect(list.map((l) => [l.purpose, l.hint])).toEqual([
      ["short.key", null],
      ["upload_post.api_key", "wxyz"],
    ]);
    expect(list[1]!.rotatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(list)).not.toContain("up_live");

    expect(await deleteSecret(db, ws, "upload_post.api_key")).toBe(true);
    expect(await getSecret(db, ws, "upload_post.api_key", keyring)).toBeNull();
    expect(await deleteSecret(db, ws, "upload_post.api_key")).toBe(false);
  });

  it("a row moved to another workspace doesn't decrypt", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const { id } = await putSecret(db, a, "resend.api_key", "re_live_secretvalue", keyring);
    await db.update(schema.vaultSecrets).set({ workspaceId: b }).where(eq(schema.vaultSecrets.id, id));
    await expect(getSecret(db, b, "resend.api_key", keyring)).rejects.toThrow();
  });

  it("resolveSecret: vault first, then env, else null", async () => {
    const ws = await newWorkspace();
    const env = { ELEVENLABS_API_KEY: "from-env" };
    expect(await resolveSecret(db, ws, "elevenlabs.api_key", "ELEVENLABS_API_KEY", { keyring, env })).toBe("from-env");
    expect(await resolveSecret(db, ws, "elevenlabs.api_key", undefined, { keyring, env })).toBeNull();
    expect(await resolveSecret(db, ws, "elevenlabs.api_key", "MISSING", { keyring, env })).toBeNull();
    await putSecret(db, ws, "elevenlabs.api_key", "from-vault-123456", keyring);
    expect(await resolveSecret(db, ws, "elevenlabs.api_key", "ELEVENLABS_API_KEY", { keyring, env })).toBe("from-vault-123456");
  });
});
