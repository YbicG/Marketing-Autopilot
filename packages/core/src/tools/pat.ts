import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { PatScope } from "@mkt/db/schema";
import type { UiSession } from "../publishing/approvals.ts";

const { auditLog, personalAccessTokens } = schema;

export const PAT_SCOPES = schema.PAT_SCOPES;
export type { PatScope };

/**
 * Personal access tokens (§8 PATs, §9). Format `mkt_pat_{prefix8}_{secret32}`, all lower-case hex:
 * the prefix finds the row, the sha256 of the whole token is compared in constant time. Tokens are
 * made and revoked only from a UI session, and no scope can approve, publish or verify (D9).
 */
export const PAT_RE = /^mkt_pat_([0-9a-f]{8})_([0-9a-f]{32})$/;
export const PAT_NAME_MAX = 60;

/** What an authenticated agent call carries. Deliberately not a UiSession. */
export interface PatContext {
  patId: string;
  workspaceId: string;
  scopes: PatScope[];
  /** The person who made the token (for the audit trail; it never stands in for their session). */
  createdBy: string;
}

export const hashPat = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export function parsePat(token: string): { prefix: string } | null {
  const m = PAT_RE.exec(token);
  return m ? { prefix: m[1]! } : null;
}

export interface MintedPat {
  /** Shown once, at creation. Only its hash is stored. */
  token: string;
  id: string;
  prefix: string;
}

export async function mintPat(
  db: Db,
  session: UiSession,
  input: { name: string; scopes: readonly PatScope[]; expiresAt?: Date | null },
  now = new Date(),
): Promise<MintedPat> {
  const name = input.name.trim().slice(0, PAT_NAME_MAX);
  if (!name) throw new Error("Give the token a name");
  const scopes = [...new Set(input.scopes)].filter((s) => (PAT_SCOPES as readonly string[]).includes(s));
  if (!scopes.length) throw new Error("Pick at least one thing the token may do");
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) throw new Error("The expiry date must be in the future");

  const prefix = randomBytes(4).toString("hex");
  const token = `mkt_pat_${prefix}_${randomBytes(16).toString("hex")}`;
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(personalAccessTokens).values({
      id,
      workspaceId: session.workspaceId,
      name,
      prefix,
      tokenHash: hashPat(token),
      scopes,
      createdBy: session.userId,
      expiresAt: input.expiresAt ?? null,
    });
    await tx.insert(auditLog).values({
      id: uuidv7(),
      workspaceId: session.workspaceId,
      actorType: "user",
      actorId: session.userId,
      action: "pat.create",
      entity: `pat:${id}`,
      data: { name, scopes, prefix },
    });
  });
  return { token, id, prefix };
}

/**
 * Bearer token → PatContext, or null (unknown, malformed, revoked, expired). The hash comparison is
 * constant-time; the prefix lookup only narrows to one row. Stamps last_used_at on success.
 */
export async function verifyPat(db: Db, token: string, now = new Date()): Promise<PatContext | null> {
  const parsed = typeof token === "string" ? parsePat(token.trim()) : null;
  if (!parsed) return null;
  const [row] = await db.select().from(personalAccessTokens).where(eq(personalAccessTokens.prefix, parsed.prefix));
  if (!row) return null;
  const want = Buffer.from(row.tokenHash, "hex");
  const given = Buffer.from(hashPat(token.trim()), "hex");
  if (want.length !== given.length || !timingSafeEqual(want, given)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  await db.update(personalAccessTokens).set({ lastUsedAt: now }).where(eq(personalAccessTokens.id, row.id));
  return { patId: row.id, workspaceId: row.workspaceId, scopes: row.scopes, createdBy: row.createdBy };
}

/** Settings → Agent access → Revoke. Takes effect on the token's next request. */
export async function revokePat(db: Db, session: UiSession, patId: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const res = await tx
      .update(personalAccessTokens)
      .set({ revokedAt: now })
      .where(and(eq(personalAccessTokens.id, patId), eq(personalAccessTokens.workspaceId, session.workspaceId), isNull(personalAccessTokens.revokedAt)))
      .returning({ id: personalAccessTokens.id });
    if (!res.length) return false;
    await tx.insert(auditLog).values({
      id: uuidv7(),
      workspaceId: session.workspaceId,
      actorType: "user",
      actorId: session.userId,
      action: "pat.revoke",
      entity: `pat:${patId}`,
    });
    return true;
  });
}

export interface PatListItem {
  id: string;
  name: string;
  /** `mkt_pat_1a2b3c4d_…`: enough to tell tokens apart, useless on its own. */
  display: string;
  scopes: PatScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export async function listPats(db: Db, workspaceId: string): Promise<PatListItem[]> {
  const rows = await db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.workspaceId, workspaceId))
    .orderBy(desc(personalAccessTokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    display: `mkt_pat_${r.prefix}_…`,
    scopes: r.scopes,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    expiresAt: r.expiresAt,
  }));
}

/** A live token of this workspace (the confirm page checks the token it confirms for). */
export async function activePat(db: Db, workspaceId: string, patId: string, now = new Date()) {
  const [row] = await db
    .select()
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.id, patId), eq(personalAccessTokens.workspaceId, workspaceId)));
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) return null;
  return { id: row.id, name: row.name, scopes: row.scopes };
}
