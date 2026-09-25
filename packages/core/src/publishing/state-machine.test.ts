import { describe, expect, it } from "vitest";
import { POST_EVENT_NAMES, POST_STATE_NAMES, type PostEventName, type PostState } from "@mkt/contracts";
import { schema } from "@mkt/db";
import {
  idempotencyKey,
  MAX_GENERATIONS,
  reconcileDelayMin,
  transition,
  type PostEvent,
  type PostSnapshot,
} from "./state-machine.ts";

const NOW = new Date("2026-10-20T15:00:00Z");
const ctx = { now: NOW, graceMin: 120 };
const future = new Date("2026-10-20T18:00:00Z");
const pastLate = new Date("2026-10-20T12:00:00Z"); // 3 h ago > 2 h grace
const pastRecent = new Date("2026-10-20T14:00:00Z"); // 1 h ago

const sample: Record<PostEventName, PostEvent> = {
  submit_for_approval: { type: "submit_for_approval" },
  approve: { type: "approve", approvalId: "appr-1" },
  enqueue: { type: "enqueue" },
  due: { type: "due" },
  prepared: { type: "prepared" },
  prepare_invalid: { type: "prepare_invalid", reason: "changed" },
  prepare_blocked: { type: "prepare_blocked", reason: "cap" },
  prepare_interrupted: { type: "prepare_interrupted" },
  accepted: { type: "accepted", requestId: "req-1" },
  published: { type: "published", url: "https://x.test/p/1" },
  failed: { type: "failed", reason: "rejected" },
  no_response: { type: "no_response", reason: "timeout" },
  still_pending: { type: "still_pending", attempt: 2 },
  lookup_found: { type: "lookup_found" },
  lookup_absent: { type: "lookup_absent" },
  drafts_mode: { type: "drafts_mode" },
  user_done: { type: "user_done", url: "https://tiktok.test/v/1" },
  post_now: { type: "post_now" },
  reschedule: { type: "reschedule", at: new Date("2026-10-21T10:00:00Z") },
  edit: { type: "edit" },
  void_approval: { type: "void_approval", reason: "re-rendered" },
  pause: { type: "pause" },
  resume: { type: "resume" },
  stale: { type: "stale", reason: "claim expired" },
  cancel: { type: "cancel" },
  posted_manually: { type: "posted_manually", url: "https://x.test/p/2" },
};

/** Expected next state for every state × event with a future slot; missing = illegal. */
const TABLE: Record<PostState, Partial<Record<PostEventName, PostState>>> = {
  draft: { submit_for_approval: "pending_approval", edit: "draft", cancel: "canceled" },
  pending_approval: { approve: "approved", edit: "pending_approval", cancel: "canceled", posted_manually: "published" },
  approved: {
    enqueue: "queued",
    edit: "pending_approval",
    void_approval: "pending_approval",
    stale: "pending_approval",
    pause: "paused",
    cancel: "canceled",
    posted_manually: "published",
  },
  queued: {
    enqueue: "queued",
    due: "preparing",
    edit: "pending_approval",
    void_approval: "pending_approval",
    stale: "pending_approval",
    pause: "paused",
    cancel: "canceled",
    posted_manually: "published",
  },
  preparing: {
    prepared: "submitting",
    prepare_invalid: "pending_approval",
    prepare_blocked: "failed",
    prepare_interrupted: "queued",
    cancel: "canceled",
  },
  submitting: {
    accepted: "submitted",
    published: "published",
    failed: "failed",
    no_response: "unknown",
    drafts_mode: "awaiting_user",
  },
  submitted: { published: "published", failed: "failed", still_pending: "submitted", drafts_mode: "awaiting_user" },
  unknown: { lookup_found: "submitted", lookup_absent: "approved", still_pending: "unknown" },
  awaiting_user: { user_done: "published", published: "published" },
  published: {},
  failed: { edit: "pending_approval", posted_manually: "published" },
  missed: {
    post_now: "approved",
    reschedule: "approved",
    edit: "pending_approval",
    void_approval: "pending_approval",
    cancel: "canceled",
    posted_manually: "published",
  },
  paused: {
    resume: "approved",
    edit: "pending_approval",
    void_approval: "pending_approval",
    stale: "pending_approval",
    cancel: "canceled",
    posted_manually: "published",
  },
  canceled: {},
};

const post = (state: PostState, over: Partial<PostSnapshot> = {}): PostSnapshot => ({
  id: "0199aaaa-0000-7000-8000-000000000001",
  state,
  generation: 1,
  scheduledAt: future,
  approvalId: "appr-1",
  ...over,
});

describe("post state machine: every state × event", () => {
  it("covers the same states as the DB enum", () => {
    expect([...POST_STATE_NAMES]).toEqual([...schema.POST_STATES]);
  });

  for (const state of POST_STATE_NAMES) {
    for (const ev of POST_EVENT_NAMES) {
      const expected = TABLE[state][ev];
      it(`${state} --${ev}--> ${expected ?? "error"}`, () => {
        const r = transition(post(state), sample[ev], ctx);
        if (expected) {
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.to).toBe(expected);
            expect(r.patch.state).toBe(expected);
            expect(r.from).toBe(state);
          }
        } else {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.error).toBeTruthy();
        }
      });
    }
  }
});

describe("post state machine: effects", () => {
  const jobId = idempotencyKey(post("queued").id, 1);

  it("enqueue adds the delayed job keyed by the idempotency key, at the slot", () => {
    const r = transition(post("approved"), { type: "enqueue" }, ctx);
    expect(r.ok && r.effects).toEqual([
      { type: "addDelayedJob", jobId, postId: post("queued").id, generation: 1, runAt: future },
    ]);
  });

  it("enqueue for a slot in the past runs now", () => {
    const r = transition(post("approved", { scheduledAt: pastRecent }), { type: "enqueue" }, ctx);
    expect(r.ok && r.effects[0]).toMatchObject({ type: "addDelayedJob", runAt: NOW });
  });

  it.each(["edit", "void_approval", "stale"] as const)("%s on a queued post voids the approval and removes the job", (ev) => {
    const r = transition(post("queued"), sample[ev], ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.effects).toContainEqual({ type: "removeDelayedJob", jobId });
    expect(r.effects.some((e) => e.type === "voidApproval" && e.approvalId === "appr-1")).toBe(true);
    expect(r.patch.approvalId).toBeNull();
    if (ev === "stale") expect(r.patch.staleReason).toBe("claim expired");
  });

  it("pause removes the job; cancel removes the job", () => {
    for (const ev of ["pause", "cancel"] as const) {
      const r = transition(post("queued"), sample[ev], ctx);
      expect(r.ok && r.effects).toContainEqual({ type: "removeDelayedJob", jobId });
    }
  });

  it("due within the grace window prepares; due more than the grace late is missed", () => {
    expect(transition(post("queued", { scheduledAt: pastRecent }), { type: "due" }, ctx)).toMatchObject({ ok: true, to: "preparing" });
    const r = transition(post("queued", { scheduledAt: pastLate }), { type: "due" }, ctx);
    expect(r).toMatchObject({ ok: true, to: "missed" });
    expect(r.ok && r.patch.missedAt).toEqual(NOW);
    expect(r.ok && r.effects.some((e) => e.type === "notify" && e.kind === "missed")).toBe(true);
  });

  it("resume after the slot passed the grace window is missed, not posted late", () => {
    expect(transition(post("paused", { scheduledAt: pastLate }), { type: "resume" }, ctx)).toMatchObject({ ok: true, to: "missed" });
    expect(transition(post("paused", { scheduledAt: pastRecent }), { type: "resume" }, ctx)).toMatchObject({ ok: true, to: "approved" });
  });

  it("only `prepared` asks for the submit, and only once", () => {
    for (const state of POST_STATE_NAMES) {
      for (const ev of POST_EVENT_NAMES) {
        const r = transition(post(state), sample[ev], ctx);
        const submits = r.ok ? r.effects.filter((e) => e.type === "submit").length : 0;
        expect(submits).toBe(state === "preparing" && ev === "prepared" ? 1 : 0);
      }
    }
  });

  it("unknown never re-sends: only lookup_absent leaves it for approved, with generation+1", () => {
    for (const ev of POST_EVENT_NAMES) {
      const r = transition(post("unknown"), sample[ev], ctx);
      if (r.ok && r.to === "approved") expect(ev).toBe("lookup_absent");
      if (r.ok) expect(r.effects.some((e) => e.type === "submit" || e.type === "addDelayedJob")).toBe(false);
    }
    const r = transition(post("unknown"), { type: "lookup_absent" }, ctx);
    expect(r.ok && r.patch).toMatchObject({ generation: 2, idempotencyKey: idempotencyKey(post("unknown").id, 2) });
  });

  it(`stops after ${MAX_GENERATIONS} generations: absent on the last one is failed (Needs you)`, () => {
    const r = transition(post("unknown", { generation: MAX_GENERATIONS }), { type: "lookup_absent" }, ctx);
    expect(r).toMatchObject({ ok: true, to: "failed" });
    expect(r.ok && r.effects.some((e) => e.type === "notify" && e.kind === "failed")).toBe(true);
  });

  it("no_response schedules a lookup, never a re-submit", () => {
    const r = transition(post("submitting"), { type: "no_response", reason: "504" }, ctx);
    expect(r.ok && r.effects.map((e) => e.type)).toEqual(["lookup"]);
    expect(r.ok && r.patch.nextReconcileAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it("publishing schedules the analytics windows", () => {
    const r = transition(post("submitted"), sample.published, ctx);
    expect(r.ok && r.effects).toContainEqual({ type: "scheduleAnalytics", publishedAt: NOW });
    expect(r.ok && r.patch.platformUrl).toBe("https://x.test/p/1");
  });

  it("reschedule must be in the future", () => {
    expect(transition(post("missed"), { type: "reschedule", at: pastRecent }, ctx).ok).toBe(false);
  });

  it("reconcile backoff is 1, 2, 5, 10, 30 then 30", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconcileDelayMin)).toEqual([1, 2, 5, 10, 30, 30, 30]);
  });
});
