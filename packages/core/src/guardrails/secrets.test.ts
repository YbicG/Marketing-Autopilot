// §8 "Secrets": provider keys live in the vault, encrypted per secret and bound to their workspace
// and purpose; the Keys page only ever sees a hint. Uploaded files are secret-scanned in memory
// and only the redacted text is stored; credential files and .env are never taken in.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyIntakePath } from "@mkt/contracts";
import { type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { processFolderUpload } from "../ingest/folder.ts";
import { seedWorkspace } from "../publishing/test-fixtures.ts";
import { looksLikeCredentialFile, scanSecrets } from "../security/secret-scan.ts";
import { decryptSecret, encryptSecret, envKeyring, getSecret, listSecrets, putSecret, secretAad, VaultKeyError } from "../security/vault.ts";
import { memoryStorage } from "../video/testing.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

// Fake tokens are built at runtime so no secret-shaped literal sits in the repo.
const GH = "ghp" + "_" + "Ab1".repeat(12);
const SK = "sk-ant-" + "api03-" + "x".repeat(90);
const keyring = envKeyring({ MKT_KEK_ACTIVE: "1", MKT_KEK_V1_B64: randomBytes(32).toString("base64") });

describe("§8 Secrets: the vault", () => {
  it("the key-encryption key must be set and exactly 32 bytes", () => {
    expect(() => envKeyring({}).kek(1)).toThrow(VaultKeyError);
    expect(() => envKeyring({ MKT_KEK_V1_B64: randomBytes(16).toString("base64") }).kek(1)).toThrow(/must be 32 bytes/);
    expect(() => envKeyring({ MKT_KEK_ACTIVE: "0" })).toThrow(VaultKeyError);
    expect(keyring.kek(1)).toHaveLength(32);
  });

  it("a sealed secret opens only with the same workspace, purpose and row", () => {
    const aad = secretAad("ws1", "resend.api_key", "id1");
    const sealed = encryptSecret(GH, aad, keyring);
    expect(JSON.stringify(sealed)).not.toContain(GH);
    expect(decryptSecret(sealed, aad, keyring)).toBe(GH);
    expect(() => decryptSecret(sealed, secretAad("ws2", "resend.api_key", "id1"), keyring)).toThrow();
    expect(() => decryptSecret(sealed, secretAad("ws1", "elevenlabs.api_key", "id1"), keyring)).toThrow();
    const otherKey = envKeyring({ MKT_KEK_V1_B64: randomBytes(32).toString("base64") });
    expect(() => decryptSecret(sealed, aad, otherKey)).toThrow();
  });

  it("stored secrets are never listed, only a 4-character hint", async () => {
    const s = await seedWorkspace(db);
    await putSecret(db, s.workspaceId, "anthropic.api_key", SK, keyring);
    expect(await getSecret(db, s.workspaceId, "anthropic.api_key", keyring)).toBe(SK);
    const list = await listSecrets(db, s.workspaceId);
    expect(list).toEqual([expect.objectContaining({ purpose: "anthropic.api_key", hint: SK.slice(-4) })]);
    expect(JSON.stringify(list)).not.toContain(SK.slice(0, 20));
    // Another workspace can't read it.
    const other = await seedWorkspace(db);
    expect(await getSecret(db, other.workspaceId, "anthropic.api_key", keyring)).toBeNull();
  });
});

describe("§8 Secrets: uploaded files", () => {
  it("secrets in text are replaced with a marker naming the rule", () => {
    const r = scanSecrets(`GITHUB_TOKEN=${GH}\nplain line`);
    expect(r.redacted).not.toContain(GH);
    expect(r.redacted).toMatch(/\[REDACTED:github-pat\]/);
    expect(r.hits).toEqual([{ rule: "github-pat", line: 1 }]);
  });

  it("credential files are recognised by content", () => {
    expect(looksLikeCredentialFile("sa.json", JSON.stringify({ type: "service_account", private_key: "x" }))).toBe(true);
    expect(looksLikeCredentialFile("notes.md", "-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
    expect(looksLikeCredentialFile("package.json", JSON.stringify({ name: "syllacal" }))).toBe(false);
  });

  it(".env, keys and credential files are refused by path before upload", () => {
    for (const p of [".env", ".env.local", "id_rsa", "docs/server.pem", "credentials.json", "secrets.md"]) {
      expect(classifyIntakePath(p, 100)).toMatchObject({ include: false, reason: "denied" });
    }
    expect(classifyIntakePath("README.md", 100)).toMatchObject({ include: true, kind: "readme" });
  });

  it("the server stores only redacted text and rejects credential content", async () => {
    const s = await seedWorkspace(db);
    const store = memoryStorage();
    const enc = (t: string) => new TextEncoder().encode(t);
    const readme = enc(`# SyllaCal\nDeploy with ${GH}\n`);
    const creds = enc(JSON.stringify({ type: "service_account", private_key: "-----BEGIN PRIVATE KEY-----" }));
    const manifest = {
      rootName: "syllacal",
      files: [
        { path: "README.md", size: readme.byteLength, kind: "readme" },
        { path: "docs/gcp.md", size: creds.byteLength, kind: "doc" },
      ],
    };
    const r = await processFolderUpload(db, store, s.workspaceId, manifest, new Map([["README.md", readme], ["docs/gcp.md", creds]]));
    expect(r.secretHits).toBe(1);
    expect(r.rejected).toEqual([{ path: "docs/gcp.md", reason: "credential_content" }]);
    const stored = [...store.objects.values()].map((b) => new TextDecoder().decode(b));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("[REDACTED:github-pat]");
    expect(stored.join("")).not.toContain(GH);
    expect(stored.join("")).not.toContain("service_account");
    // A manifest that lists .env is refused outright.
    await expect(processFolderUpload(db, store, s.workspaceId, { rootName: "x", files: [{ path: ".env", size: 1, kind: "doc" }] }, new Map())).rejects.toThrow(/didn't pass our checks/);
  });

  it.todo("agent personal access tokens are stored hashed, shown once — M5 (PATs not built)");
});
