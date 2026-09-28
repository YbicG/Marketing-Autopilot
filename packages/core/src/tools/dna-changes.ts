import { and, desc, eq } from "drizzle-orm";
import { DNA_SECTIONS } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { currentDna, editDnaField } from "../ingest/dna.ts";
import type { UiSession } from "../publishing/approvals.ts";

const { auditLog, dnaChangeRequests } = schema;

/**
 * Agent edits to the product profile (§8 claims, §9 propose_dna_change). An agent never edits the
 * profile or its facts: it files a pending request, and the owner accepts or rejects it on the plan
 * screen. Accepting takes a UiSession, so only a signed-in person in the app can do it.
 */

export const DNA_PATH_RE = /^[a-z]+\.[A-Za-z]+$/;

type Checkable = { safeParse(v: unknown): { success: boolean } };

/** The zod schema for one top-level profile field ("identity.oneLiner"), so a change can't break its shape. */
export function dnaFieldSchema(path: string): Checkable | null {
  if (!DNA_PATH_RE.test(path)) return null;
  const [section, key] = path.split(".");
  const sec = (DNA_SECTIONS as unknown as Record<string, { shape: Record<string, Checkable> } | undefined>)[section ?? ""];
  return (key && sec?.shape[key]) || null;
}

export type ProposeResult = { ok: true; requestId: string } | { ok: false; message: string };

export async function proposeDnaChange(
  db: Db,
  workspaceId: string,
  productId: string,
  input: { path: string; value: unknown; reason?: string | null; patId: string | null },
): Promise<ProposeResult> {
  const schemaFor = dnaFieldSchema(input.path);
  if (!schemaFor) return { ok: false, message: `${input.path} isn't a profile field that can be changed.` };
  if (!schemaFor.safeParse(input.value).success) return { ok: false, message: `That value doesn't fit ${input.path}. Check its shape with get_product_dna.` };
  const dna = await currentDna(db, productId);
  if (!dna || dna.workspaceId !== workspaceId) return { ok: false, message: "This product has no profile yet." };
  const id = uuidv7();
  await db.insert(dnaChangeRequests).values({
    id,
    workspaceId,
    productId,
    dnaVersionId: dna.id,
    path: input.path,
    value: input.value ?? null,
    reason: input.reason?.trim().slice(0, 500) || null,
    patId: input.patId,
  });
  return { ok: true, requestId: id };
}

export type DnaChangeRequest = typeof dnaChangeRequests.$inferSelect;

export async function pendingDnaChanges(db: Db, workspaceId: string, productId: string): Promise<DnaChangeRequest[]> {
  return db
    .select()
    .from(dnaChangeRequests)
    .where(and(eq(dnaChangeRequests.workspaceId, workspaceId), eq(dnaChangeRequests.productId, productId), eq(dnaChangeRequests.status, "pending")))
    .orderBy(desc(dnaChangeRequests.createdAt));
}

export type DecideResult = { ok: true } | { ok: false; message: string };

/** Plan screen → Accept: applies the change as the owner's own edit (pinned), if the profile hasn't moved on. */
export async function acceptDnaChange(db: Db, session: UiSession, requestId: string, now = new Date()): Promise<DecideResult> {
  const req = await pendingRequest(db, session.workspaceId, requestId);
  if (!req) return { ok: false, message: "That suggestion is gone or was already handled." };
  const dna = await currentDna(db, req.productId);
  if (!dna || dna.id !== req.dnaVersionId) {
    await decide(db, session, req, "rejected", now, { why: "profile_changed" });
    return { ok: false, message: "The profile was rewritten after this was suggested, so it was set aside." };
  }
  try {
    const ok = await editDnaField(db, session.workspaceId, req.dnaVersionId, req.path, req.value);
    if (!ok) return { ok: false, message: "The profile wasn't found." };
  } catch {
    return { ok: false, message: "That field can't be changed." };
  }
  await decide(db, session, req, "accepted", now);
  return { ok: true };
}

export async function rejectDnaChange(db: Db, session: UiSession, requestId: string, now = new Date()): Promise<DecideResult> {
  const req = await pendingRequest(db, session.workspaceId, requestId);
  if (!req) return { ok: false, message: "That suggestion is gone or was already handled." };
  await decide(db, session, req, "rejected", now);
  return { ok: true };
}

async function pendingRequest(db: Db, workspaceId: string, id: string) {
  const [r] = await db
    .select()
    .from(dnaChangeRequests)
    .where(and(eq(dnaChangeRequests.id, id), eq(dnaChangeRequests.workspaceId, workspaceId), eq(dnaChangeRequests.status, "pending")));
  return r ?? null;
}

async function decide(db: Db, session: UiSession, req: DnaChangeRequest, status: "accepted" | "rejected", now: Date, extra: Record<string, unknown> = {}) {
  await db.transaction(async (tx) => {
    await tx
      .update(dnaChangeRequests)
      .set({ status, decidedBy: session.userId, decidedAt: now })
      .where(and(eq(dnaChangeRequests.id, req.id), eq(dnaChangeRequests.status, "pending")));
    await tx.insert(auditLog).values({
      id: uuidv7(),
      workspaceId: session.workspaceId,
      actorType: "user",
      actorId: session.userId,
      action: `dna_change.${status === "accepted" ? "accept" : "reject"}`,
      entity: `dna_change_request:${req.id}`,
      data: { path: req.path, patId: req.patId, ...extra },
    });
  });
}
