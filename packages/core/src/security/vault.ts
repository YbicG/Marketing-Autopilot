import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";

const { vaultSecrets } = schema;

/**
 * §8 vault: envelope encryption. Each secret gets a random 256-bit DEK (AES-256-GCM); the DEK is
 * wrapped with the KEK `MKT_KEK_V{n}_B64` (also AES-256-GCM, its own iv/tag). Both use the AAD
 * `${workspaceId}:${purpose}:${secretId}`, so a row copied to another workspace or purpose fails.
 * wrapped_dek = base64(iv 12 ‖ tag 16 ‖ encrypted DEK 32). D19: lookups go vault first, then env.
 */

export interface Keyring {
  active: number;
  /** The 32-byte KEK for a version. Throws if it's missing or the wrong size. */
  kek(version: number): Buffer;
}

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

export function envKeyring(e: NodeJS.ProcessEnv = process.env): Keyring {
  const active = Number(e.MKT_KEK_ACTIVE ?? "1");
  if (!Number.isInteger(active) || active < 1) throw new VaultKeyError("MKT_KEK_ACTIVE must be a positive whole number");
  return {
    active,
    kek(version) {
      const name = `MKT_KEK_V${version}_B64`;
      const raw = e[name];
      if (!raw) throw new VaultKeyError(`${name} is not set`);
      const key = Buffer.from(raw, "base64");
      if (key.length !== 32) throw new VaultKeyError(`${name} must be 32 bytes of base64 (got ${key.length})`);
      return key;
    },
  };
}

export function secretAad(workspaceId: string, purpose: string, secretId: string): Buffer {
  return Buffer.from(`${workspaceId}:${purpose}:${secretId}`, "utf8");
}

function seal(key: Buffer, plain: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export interface SealedSecret {
  kekVersion: number;
  wrappedDek: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptSecret(value: string, aad: Buffer, keyring: Keyring): SealedSecret {
  const kekVersion = keyring.active;
  const kek = keyring.kek(kekVersion);
  const dek = randomBytes(32);
  try {
    const body = seal(dek, Buffer.from(value, "utf8"), aad);
    const wrap = seal(kek, dek, aad);
    return {
      kekVersion,
      wrappedDek: Buffer.concat([wrap.iv, wrap.tag, wrap.ct]).toString("base64"),
      iv: body.iv.toString("base64"),
      tag: body.tag.toString("base64"),
      ciphertext: body.ct.toString("base64"),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(sealed: SealedSecret, aad: Buffer, keyring: Keyring): string {
  const kek = keyring.kek(sealed.kekVersion);
  const w = Buffer.from(sealed.wrappedDek, "base64");
  if (w.length !== 12 + 16 + 32) throw new Error("vault: wrapped key is corrupt");
  const dek = open(kek, w.subarray(0, 12), w.subarray(12, 28), w.subarray(28), aad);
  try {
    return open(dek, Buffer.from(sealed.iv, "base64"), Buffer.from(sealed.tag, "base64"), Buffer.from(sealed.ciphertext, "base64"), aad).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Last 4 characters for the Keys page, only when that leaves most of the secret hidden. */
export function secretHint(value: string): string | null {
  return value.length >= 12 ? value.slice(-4) : null;
}

/** Create or replace the workspace's secret for `purpose`. Replacing keeps the row id (and so the AAD shape). */
export async function putSecret(db: Db, workspaceId: string, purpose: string, value: string, keyring: Keyring = envKeyring()): Promise<{ id: string; hint: string | null }> {
  if (!value) throw new Error("vault: empty secret");
  const [existing] = await db
    .select({ id: vaultSecrets.id })
    .from(vaultSecrets)
    .where(and(eq(vaultSecrets.workspaceId, workspaceId), eq(vaultSecrets.purpose, purpose)));
  const id = existing?.id ?? uuidv7();
  const sealed = encryptSecret(value, secretAad(workspaceId, purpose, id), keyring);
  const hint = secretHint(value);
  if (existing) {
    await db
      .update(vaultSecrets)
      .set({ ...sealed, hint, rotatedAt: new Date() })
      .where(and(eq(vaultSecrets.id, id), eq(vaultSecrets.workspaceId, workspaceId)));
  } else {
    await db.insert(vaultSecrets).values({ id, workspaceId, purpose, ...sealed, hint });
  }
  return { id, hint };
}

/** The decrypted secret, or null if none is stored. A row that fails to decrypt throws (never silently falls back). */
export async function getSecret(db: Db, workspaceId: string, purpose: string, keyring?: Keyring): Promise<string | null> {
  const [row] = await db
    .select()
    .from(vaultSecrets)
    .where(and(eq(vaultSecrets.workspaceId, workspaceId), eq(vaultSecrets.purpose, purpose)));
  if (!row) return null;
  return decryptSecret(row, secretAad(workspaceId, purpose, row.id), keyring ?? envKeyring());
}

export async function deleteSecret(db: Db, workspaceId: string, purpose: string): Promise<boolean> {
  const rows = await db
    .delete(vaultSecrets)
    .where(and(eq(vaultSecrets.workspaceId, workspaceId), eq(vaultSecrets.purpose, purpose)))
    .returning({ id: vaultSecrets.id });
  return rows.length > 0;
}

/** For Settings → Keys: never the value, only what's stored and its hint. */
export async function listSecrets(
  db: Db,
  workspaceId: string,
): Promise<{ purpose: string; hint: string | null; createdAt: Date; rotatedAt: Date | null }[]> {
  return db
    .select({ purpose: vaultSecrets.purpose, hint: vaultSecrets.hint, createdAt: vaultSecrets.createdAt, rotatedAt: vaultSecrets.rotatedAt })
    .from(vaultSecrets)
    .where(eq(vaultSecrets.workspaceId, workspaceId))
    .orderBy(vaultSecrets.purpose);
}

/** D19: the vault first, then the env var (if named). Null means "not configured": show the fallback. */
export async function resolveSecret(
  db: Db,
  workspaceId: string,
  purpose: string,
  envName?: string,
  opts: { keyring?: Keyring; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const stored = await getSecret(db, workspaceId, purpose, opts.keyring);
  if (stored) return stored;
  if (!envName) return null;
  return (opts.env ?? process.env)[envName] || null;
}
