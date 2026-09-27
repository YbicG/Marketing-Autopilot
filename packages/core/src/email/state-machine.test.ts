import { describe, expect, it } from "vitest";
import { BROADCAST_STATES, type BroadcastState } from "@mkt/db/schema";
import { BROADCAST_EVENTS, transitionBroadcast, type BroadcastEvent, type BroadcastSnapshot } from "./state-machine.ts";

const ID = "0190a5f0-0000-7000-8000-000000000001";
const at = new Date("2027-01-06T15:00:00Z");

const EVENTS: Record<(typeof BROADCAST_EVENTS)[number], BroadcastEvent> = {
  generated: { type: "generated" },
  submit_for_approval: { type: "submit_for_approval" },
  edit: { type: "edit" },
  approve: { type: "approve", approvalId: "appr-2", seq: 2 },
  scheduled: { type: "scheduled", resendBroadcastId: "rb_1" },
  sent: { type: "sent", at },
  submit_failed: { type: "submit_failed", reason: "Resend said no" },
  void_approval: { type: "void_approval", reason: "Taken back" },
  pause: { type: "pause" },
  cancel: { type: "cancel", reason: "Not needed" },
};

type Expect = { to: BroadcastState; effects?: ("submit" | "cancel")[] } | null;

// Every state × event, with a Resend broadcast on record where the state can have one.
// `null` = refused. Effects are listed when the state holds a Resend id (see snapshot below).
const TABLE: Record<BroadcastState, Record<(typeof BROADCAST_EVENTS)[number], Expect>> = {
  draft: {
    generated: { to: "pending_approval" },
    submit_for_approval: { to: "pending_approval" },
    edit: { to: "draft" },
    approve: null,
    scheduled: null,
    sent: null,
    submit_failed: null,
    void_approval: null,
    pause: null,
    cancel: { to: "canceled" },
  },
  pending_approval: {
    generated: { to: "pending_approval" },
    submit_for_approval: null,
    edit: { to: "pending_approval" },
    approve: { to: "approved", effects: ["submit"] },
    scheduled: null,
    sent: { to: "sent" },
    submit_failed: null,
    void_approval: { to: "pending_approval" },
    pause: { to: "pending_approval" },
    cancel: { to: "canceled" },
  },
  approved: {
    generated: null,
    submit_for_approval: null,
    edit: { to: "pending_approval", effects: ["cancel"] },
    approve: null,
    scheduled: { to: "scheduled_at_resend" },
    sent: { to: "sent" },
    submit_failed: { to: "failed" },
    void_approval: { to: "pending_approval", effects: ["cancel"] },
    pause: { to: "pending_approval", effects: ["cancel"] },
    cancel: { to: "canceled", effects: ["cancel"] },
  },
  scheduled_at_resend: {
    generated: null,
    submit_for_approval: null,
    edit: { to: "pending_approval", effects: ["cancel"] },
    approve: null,
    scheduled: { to: "scheduled_at_resend" },
    sent: { to: "sent" },
    submit_failed: null,
    void_approval: { to: "pending_approval", effects: ["cancel"] },
    pause: { to: "pending_approval", effects: ["cancel"] },
    cancel: { to: "canceled", effects: ["cancel"] },
  },
  failed: {
    generated: null,
    submit_for_approval: { to: "pending_approval", effects: ["cancel"] },
    edit: { to: "pending_approval", effects: ["cancel"] },
    approve: null,
    scheduled: null,
    sent: { to: "sent" },
    submit_failed: null,
    void_approval: null,
    pause: null,
    cancel: { to: "canceled", effects: ["cancel"] },
  },
  sent: {
    generated: null,
    submit_for_approval: null,
    edit: null,
    approve: null,
    scheduled: null,
    sent: { to: "sent" },
    submit_failed: null,
    void_approval: null,
    pause: null,
    cancel: null,
  },
  canceled: {
    generated: null,
    submit_for_approval: null,
    edit: null,
    approve: null,
    scheduled: null,
    sent: { to: "sent" },
    submit_failed: null,
    void_approval: null,
    pause: null,
    cancel: null,
  },
};

const snap = (status: BroadcastState, resend = true): BroadcastSnapshot => ({
  id: ID,
  status,
  approvalId: ["approved", "scheduled_at_resend", "failed"].includes(status) ? "appr-1" : null,
  resendBroadcastId: resend && ["approved", "scheduled_at_resend", "failed", "sent"].includes(status) ? "rb_0" : null,
  approvalSeq: 1,
});

describe("email_broadcasts machine: every state × event", () => {
  it("covers every state and event", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...BROADCAST_STATES].sort());
    for (const s of BROADCAST_STATES) expect(Object.keys(TABLE[s]).sort()).toEqual([...BROADCAST_EVENTS].sort());
  });

  for (const s of BROADCAST_STATES) {
    for (const e of BROADCAST_EVENTS) {
      const want = TABLE[s][e];
      it(`${s} --${e}--> ${want ? want.to : "refused"}`, () => {
        const r = transitionBroadcast(snap(s), EVENTS[e]);
        if (!want) {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.error).toMatch(/\S/);
          return;
        }
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.to).toBe(want.to);
        expect(r.patch.status).toBe(want.to);
        expect(r.effects.map((x) => x.type)).toEqual(want.effects ?? []);
      });
    }
  }
});

describe("effects and patches", () => {
  it("approve submits with a job id per approval", () => {
    const r = transitionBroadcast(snap("pending_approval"), { type: "approve", approvalId: "appr-9", seq: 3 });
    expect(r.ok && r.effects).toEqual([{ type: "submit", broadcastId: ID, jobId: `bc-${ID}-3` }]);
    expect(r.ok && r.patch.approvalId).toBe("appr-9");
  });

  it("an edit after it's scheduled cancels at Resend, voids the approval and goes back for approval", () => {
    const r = transitionBroadcast(snap("scheduled_at_resend"), { type: "edit" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.to).toBe("pending_approval");
    expect(r.effects).toEqual([{ type: "cancel", broadcastId: ID, jobId: `bcx-${ID}-1`, reason: "Edited after it was scheduled" }]);
    expect(r.voidApprovalId).toBe("appr-1");
    expect(r.patch.approvalId).toBeNull();
  });

  it("nothing to cancel when Resend holds nothing yet", () => {
    for (const s of ["approved", "failed"] as const) {
      const r = transitionBroadcast(snap(s, false), { type: "edit" });
      expect(r.ok && r.effects).toEqual([]);
    }
  });

  it("a cancel that lost the race to delivery records that it went out", () => {
    const r = transitionBroadcast(snap("pending_approval"), { type: "sent", at });
    expect(r.ok && r.patch).toMatchObject({ status: "sent", sentAt: at, lastError: expect.stringMatching(/already gone out/) });
    const s = transitionBroadcast(snap("scheduled_at_resend"), { type: "sent", at });
    expect(s.ok && s.patch.lastError).toBeNull();
  });

  it("pause explains itself", () => {
    const r = transitionBroadcast(snap("scheduled_at_resend"), { type: "pause" });
    expect(r.ok && r.patch.lastError).toMatch(/paused/);
  });
});
