import { BroadcastPatch, broadcastBodyText, broadcastParagraphs, type EmailIssue } from "@mkt/contracts";
import type { Db } from "@mkt/db";
import { broadcastContext, checkRow, renderRow } from "./context.ts";
import { loadBroadcast, type BroadcastRow } from "./store.ts";

export interface BroadcastPreview {
  html: string;
  text: string;
  issues: EmailIssue[];
}

const PreviewInput = BroadcastPatch.pick({ subject: true, preheader: true, body: true });

/**
 * The editor's live preview: render and check unsaved text exactly as saveBroadcast would store it,
 * without writing anything (so typing never takes an approved broadcast back from Resend).
 */
export async function previewBroadcast(
  db: Db,
  workspaceId: string,
  id: string,
  draft: unknown,
  opts: { now?: Date } = {},
): Promise<{ ok: true; preview: BroadcastPreview } | { ok: false; reason: string }> {
  const parsed = PreviewInput.safeParse(draft ?? {});
  if (!parsed.success) return { ok: false, reason: "Something in the email is too long. Shorten it and try again." };
  const row = await loadBroadcast(db, workspaceId, id);
  if (!row) return { ok: false, reason: "Broadcast not found." };
  const ctx = await broadcastContext(db, row);
  if (!ctx) return { ok: false, reason: "This broadcast's product is missing." };
  const p = parsed.data;
  const next: BroadcastRow = {
    ...row,
    ...(p.subject !== undefined ? { subject: p.subject.replace(/[\r\n]+/g, " ").trim() } : {}),
    ...(p.preheader !== undefined ? { preheader: p.preheader?.replace(/[\r\n]+/g, " ").trim() || null } : {}),
    ...(p.body !== undefined ? { body: broadcastBodyText(broadcastParagraphs(p.body)) } : {}),
  };
  const rendered = renderRow(next, ctx);
  const issues = await checkRow(db, next, ctx, opts.now ?? new Date(), rendered);
  return { ok: true, preview: { html: rendered.html, text: rendered.text, issues } };
}
