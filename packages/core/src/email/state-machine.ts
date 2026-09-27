import type { BroadcastState } from "@mkt/db/schema";

/**
 * The email_broadcasts machine (§4.3), pure like publishing/state-machine.ts:
 *
 *   draft --generated|submit_for_approval--> pending_approval --approve (UI session)--> approved
 *   approved --scheduled (Resend accepted scheduled_at)--> scheduled_at_resend --sent--> sent
 *   approved --submit_failed--> failed --edit--> pending_approval
 *   pending_approval|approved|scheduled_at_resend --edit | void_approval | pause--> pending_approval
 *   any state before sent --cancel--> canceled
 *
 * "An edit cancels at Resend" (M4-LC done-when): leaving scheduled_at_resend, or leaving approved
 * once a Resend broadcast exists, carries a `cancel` effect. Pause has no state of its own: the
 * broadcast goes back for approval, because the approved send time may be gone by the resume.
 * `sent` is a fact reported by Resend, so it's accepted from any state after approval (a cancel that
 * lost the race to delivery records that it went out).
 */

export type BroadcastEvent =
  | { type: "generated" }
  | { type: "submit_for_approval" }
  | { type: "edit" }
  | { type: "approve"; approvalId: string; seq: number }
  | { type: "scheduled"; resendBroadcastId: string }
  | { type: "sent"; at: Date }
  | { type: "submit_failed"; reason: string }
  | { type: "void_approval"; reason: string }
  | { type: "pause" }
  | { type: "cancel"; reason?: string };

export const BROADCAST_EVENTS = [
  "generated",
  "submit_for_approval",
  "edit",
  "approve",
  "scheduled",
  "sent",
  "submit_failed",
  "void_approval",
  "pause",
  "cancel",
] as const satisfies readonly BroadcastEvent["type"][];

export interface BroadcastSnapshot {
  id: string;
  status: BroadcastState;
  approvalId: string | null;
  resendBroadcastId: string | null;
  /** How many approvals this broadcast has had; job ids use it so each approval submits once. */
  approvalSeq: number;
}

/** Data, applied after the transaction commits: enqueue email.submit / email.cancel on the publish queue. */
export type EmailEffect =
  | { type: "submit"; broadcastId: string; jobId: string; delayMs?: number }
  | { type: "cancel"; broadcastId: string; jobId: string; reason: string };

export interface BroadcastPatch {
  status: BroadcastState;
  approvalId?: string | null;
  resendBroadcastId?: string | null;
  lastError?: string | null;
  sentAt?: Date | null;
}

export type BroadcastTransition =
  | { ok: true; from: BroadcastState; to: BroadcastState; patch: BroadcastPatch; effects: EmailEffect[]; voidApprovalId: string | null }
  | { ok: false; from: BroadcastState; event: BroadcastEvent["type"]; error: string };

export const submitJobId = (broadcastId: string, seq: number) => `bc-${broadcastId}-${seq}`;
export const cancelJobId = (broadcastId: string, seq: number) => `bcx-${broadcastId}-${seq}`;

/** States that may hold a live broadcast at Resend. */
export const RESEND_LIVE_STATES: readonly BroadcastState[] = ["approved", "scheduled_at_resend"];
export const EDITABLE_STATES: readonly BroadcastState[] = ["draft", "pending_approval", "approved", "scheduled_at_resend", "failed"];

const LABELS: Record<BroadcastState, string> = {
  draft: "Drafting",
  pending_approval: "Needs your approval",
  approved: "Approved",
  scheduled_at_resend: "Scheduled",
  sent: "Sent",
  canceled: "Canceled",
  failed: "Failed",
};
export const broadcastStatusLabel = (s: BroadcastState) => LABELS[s];

export function transitionBroadcast(b: BroadcastSnapshot, event: BroadcastEvent): BroadcastTransition {
  const from = b.status;
  const ok = (to: BroadcastState, patch: Omit<BroadcastPatch, "status"> = {}, effects: EmailEffect[] = [], voidApprovalId: string | null = null): BroadcastTransition => ({
    ok: true,
    from,
    to,
    patch: { ...patch, status: to },
    effects,
    voidApprovalId,
  });
  const illegal = (why?: string): BroadcastTransition => ({
    ok: false,
    from,
    event: event.type,
    error: why ?? `A broadcast that is ${LABELS[from].toLowerCase()} can't ${event.type.replaceAll("_", " ")}.`,
  });
  const cancelAt = (reason: string): EmailEffect[] =>
    b.resendBroadcastId && (from === "scheduled_at_resend" || from === "approved" || from === "failed")
      ? [{ type: "cancel", broadcastId: b.id, jobId: cancelJobId(b.id, b.approvalSeq), reason }]
      : [];
  /** Back for approval: the approval is voided, and whatever Resend holds is canceled. */
  const back = (reason: string, lastError: string | null) => ok("pending_approval", { approvalId: null, lastError }, cancelAt(reason), b.approvalId);

  switch (event.type) {
    case "cancel":
      if (from === "sent" || from === "canceled") return illegal(`This broadcast is already ${LABELS[from].toLowerCase()}.`);
      return ok("canceled", { approvalId: null }, cancelAt(event.reason ?? "Canceled"), b.approvalId);
    case "sent":
      if (from === "draft") return illegal();
      if (from === "sent") return ok("sent");
      return ok("sent", { sentAt: event.at, lastError: from === "approved" || from === "scheduled_at_resend" ? null : "It had already gone out before the change reached Resend." });
    default:
      break;
  }

  switch (from) {
    case "draft":
      if (event.type === "generated" || event.type === "submit_for_approval") return ok("pending_approval");
      if (event.type === "edit") return ok("draft");
      return illegal();

    case "pending_approval":
      if (event.type === "approve") {
        return ok("approved", { approvalId: event.approvalId, lastError: null }, [{ type: "submit", broadcastId: b.id, jobId: submitJobId(b.id, event.seq) }]);
      }
      if (event.type === "edit" || event.type === "generated") return ok("pending_approval");
      if (event.type === "pause") return ok("pending_approval");
      if (event.type === "void_approval") return ok("pending_approval", { approvalId: null }, [], b.approvalId);
      return illegal();

    case "approved":
      if (event.type === "scheduled") return ok("scheduled_at_resend", { resendBroadcastId: event.resendBroadcastId, lastError: null });
      if (event.type === "submit_failed") return ok("failed", { lastError: event.reason });
      if (event.type === "edit") return back("Edited after approval", null);
      if (event.type === "void_approval") return back(event.reason, null);
      if (event.type === "pause") return back("Posting was paused", "Posting was paused. Approve it again when you resume.");
      return illegal();

    case "scheduled_at_resend":
      if (event.type === "scheduled") return ok("scheduled_at_resend", { resendBroadcastId: event.resendBroadcastId });
      if (event.type === "edit") return back("Edited after it was scheduled", null);
      if (event.type === "void_approval") return back(event.reason, null);
      if (event.type === "pause") return back("Posting was paused", "Posting was paused, so we canceled it at Resend. Approve it again when you resume.");
      return illegal();

    case "failed":
      if (event.type === "edit" || event.type === "submit_for_approval") return back("Edited after it failed", null);
      return illegal();

    case "sent":
    case "canceled":
      return illegal(`This broadcast is already ${LABELS[from].toLowerCase()}.`);
  }
}
