import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";

/** `ALLOWED_GITHUB_LOGINS` is a comma list. Empty means nobody: there is no open signup. */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedLogin(login: unknown, allow: Set<string>): boolean {
  return typeof login === "string" && allow.has(login.toLowerCase());
}

/** Called from better-auth's user.create.after hook. Idempotent: a user owns exactly one workspace. */
export async function ensureWorkspaceForUser(db: Db, user: { id: string; name?: string | null }): Promise<string> {
  const [existing] = await db
    .select({ id: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, user.id))
    .limit(1);
  if (existing) return existing.id;

  const workspaceId = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(schema.workspaces).values({ id: workspaceId, name: user.name ? `${user.name}'s workspace` : "My workspace" });
    await tx.insert(schema.workspaceMembers).values({ id: uuidv7(), workspaceId, userId: user.id, role: "owner" });
    await tx.insert(schema.auditLog).values({
      id: uuidv7(),
      workspaceId,
      actorType: "user",
      actorId: user.id,
      action: "workspace.create",
    });
  });
  return workspaceId;
}

export async function workspaceIdForUser(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, userId))
    .limit(1);
  return row?.id ?? null;
}

/** Delete cascade (M0 done-when): every tenant row hangs off workspaces with ON DELETE CASCADE. */
export async function deleteWorkspace(db: Db, workspaceId: string): Promise<void> {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
}

export async function githubLoginForUser(db: Db, userId: string): Promise<string | null> {
  const [u] = await db
    .select({ login: schema.users.githubLogin })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return u?.login ?? null;
}
