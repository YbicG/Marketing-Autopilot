import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { ClaudeRefused } from "../ai/stop-reasons.ts";
import { BudgetExceeded } from "../cost/errors.ts";
import { describeFailure } from "../runs/summary.ts";

const { contentItems } = schema;

/** §4.3 video item states (content_items.status). */
export type VideoItemState = (typeof contentItems.$inferSelect)["status"];

export type VideoItemEvent =
  | "start" // planned/failed/needs_you → generating (script + spec + draft voice)
  | "generated" // generating → ready (the preview plays in the editor)
  | "edit" // a spec edit or "Ask for changes" applied → ready
  | "revoice" // one line re-voiced → ready
  | "finalize" // Gate 1 confirmed → finalizing
  | "final_qa_passed" // every opening line rendered + QA → final_ready
  | "approve" // the variants were approved → approved
  | "needs_you"
  | "fail"
  | "skip";

export class BadVideoTransition extends Error {
  readonly code = "bad_transition";
  constructor(
    readonly from: VideoItemState,
    readonly event: VideoItemEvent,
  ) {
    super(`This video can't do that right now (it is ${from.replace("_", " ")}).`);
    this.name = "BadVideoTransition";
  }
}

const FROM: Record<VideoItemEvent, readonly VideoItemState[]> = {
  start: ["planned", "failed", "needs_you", "generating"],
  generated: ["generating"],
  edit: ["ready", "needs_you", "final_ready", "approved", "failed"],
  revoice: ["ready", "needs_you", "final_ready", "approved"],
  finalize: ["ready", "needs_you", "finalizing", "final_ready", "approved"],
  final_qa_passed: ["finalizing", "final_ready"],
  approve: ["final_ready", "approved"],
  needs_you: ["planned", "generating", "ready", "finalizing", "final_ready", "needs_you", "approved"],
  fail: ["planned", "generating", "ready", "finalizing", "final_ready", "needs_you", "failed"],
  skip: ["planned", "generating", "ready", "needs_you", "failed", "final_ready", "finalizing", "skipped"],
};

const TO: Record<VideoItemEvent, VideoItemState> = {
  start: "generating",
  generated: "ready",
  edit: "ready",
  revoice: "ready",
  finalize: "finalizing",
  final_qa_passed: "final_ready",
  approve: "approved",
  needs_you: "needs_you",
  fail: "failed",
  skip: "skipped",
};

/**
 * Pure §4.3 machine. `voidApproval` is true whenever the files or the words of an approved (or
 * approvable) video change: any re-voice, edit, re-render or re-finalize after final_ready.
 */
export function transitionVideoItem(from: VideoItemState, event: VideoItemEvent): { next: VideoItemState; voidApproval: boolean } {
  if (!FROM[event].includes(from)) throw new BadVideoTransition(from, event);
  const changesFiles = event === "edit" || event === "revoice" || event === "finalize" || event === "fail" || event === "skip";
  return { next: TO[event], voidApproval: changesFiles && (from === "final_ready" || from === "approved") };
}

/** Workspace-scoped status write; mutates `item` so callers keep a current copy. */
export async function setItemStatus(
  db: Db,
  item: { id: string; workspaceId: string; status: VideoItemState; needsYouReason?: string | null },
  status: VideoItemState,
  reason: string | null = null,
): Promise<void> {
  const needsYouReason = status === "needs_you" ? reason : null;
  await db
    .update(contentItems)
    .set({ status, needsYouReason, updatedAt: new Date() })
    .where(and(eq(contentItems.id, item.id), eq(contentItems.workspaceId, item.workspaceId)));
  item.status = status;
  item.needsYouReason = needsYouReason;
}

/** Errors whose message is already a plain-English "what to do" line. */
const PLAIN_CODES = new Set(["needs_you", "finalize_not_confirmed", "tier_blocked", "bad_transition", "not_found", "upload_rejected"]);

/** The plain-English Needs you line for an error (D15: a refusal is Needs you with the reason). */
export function reasonFor(err: unknown): string {
  if (err instanceof ClaudeRefused) return "Claude declined to write this video. Check the product notes and the brief, then try again.";
  if (err instanceof BudgetExceeded) return describeFailure(err).message;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && PLAIN_CODES.has(code) && err instanceof Error) return err.message.slice(0, 500);
  const d = describeFailure(err);
  return d.code === "failed" ? "Making this video failed. Try again in a minute." : d.message;
}
