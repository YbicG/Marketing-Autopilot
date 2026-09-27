// §8 "A human approves every publish": the approval hash covers the final media; edits, re-renders
// and auto-fixes void it; only a UiSession (cookie + Origin + CSRF, minted in apps/web) can approve.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { approveBroadcast } from "../email/ui.ts";
import { approvePosts, editPost, onVariantChanged, uiSessionFromCookie, voidApproval } from "../publishing/approvals.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { approvalHash } from "../publishing/hash.ts";
import { addPost, MEDIA } from "../publishing/test-fixtures.ts";
import { approvedPost, postRow, sessionFor, SLOT, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("§8 A human approves every publish", () => {
  it("the approval hash includes the final media, in order", () => {
    const base = { text: "Your syllabus, now a calendar", mediaSha256s: ["a".repeat(64), "b".repeat(64)], platformOptions: {} };
    const h = approvalHash(base);
    expect(approvalHash({ ...base, mediaSha256s: ["a".repeat(64), "c".repeat(64)] })).not.toBe(h);
    expect(approvalHash({ ...base, mediaSha256s: ["b".repeat(64), "a".repeat(64)] })).not.toBe(h);
    expect(approvalHash({ ...base, mediaSha256s: ["a".repeat(64)] })).not.toBe(h);
    expect(approvalHash({ ...base, platformOptions: { markAsAi: true } })).not.toBe(h);
    expect(approvalHash({ ...base })).toBe(h);
  });

  it("a post with no approval row never publishes", async () => {
    const w = await world(db);
    const id = await addPost(db, w.s, SLOT, { state: "queued" });
    w.clock.now = new Date(SLOT.getTime() + 60_000);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect(w.adapter.submits).toHaveLength(0);
  });

  it("a media file swapped after approval (new sha256 on the asset) sends the post back", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await db.update(schema.assets).set({ sha256: "f".repeat(64) }).where(eq(schema.assets.id, w.s.assetId));
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect(w.adapter.submits).toHaveLength(0);
  });

  it("stored bytes that no longer match the approved sha256 are refused at upload time", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, w.s.assetId));
    MEDIA.set(asset!.storageKey, new TextEncoder().encode("different bytes"));
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect((await postRow(db, id)).lastError).toBe("The file changed after you approved it. Approve it again.");
  });

  it("a text edit (editor save, auto-fix) voids the approval", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    const [v] = await db.select().from(schema.variants).where(eq(schema.variants.id, w.s.variantId));
    const body = structuredClone(v!.body) as { variant: { text: string } };
    body.variant.text = "Your syllabus, now a calendar. Edited.";
    await db.update(schema.variants).set({ body }).where(eq(schema.variants.id, w.s.variantId));
    const r = await onVariantChanged(db, w.s.workspaceId, w.s.variantId, { type: "user", id: "user-1" });
    expect(r.map((x) => x.postId)).toEqual([id]);
    expect((await postRow(db, id)).state).toBe("pending_approval");
  });

  it("a platform options change voids the approval", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await editPost(db, w.s.workspaceId, id, { platformOptions: { markAsAi: true } }, { type: "user", id: "user-1" });
    expect((await postRow(db, id)).state).toBe("pending_approval");
  });

  it("a re-render (worker) can void an approval; voiding only removes permission", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await voidApproval(db, w.s.workspaceId, id, "The video was rendered again.", { type: "worker" });
    expect((await postRow(db, id)).state).toBe("pending_approval");
    const [appr] = await db.select().from(schema.approvals).where(eq(schema.approvals.entityId, id));
    expect(appr!.voidReason).toBe("The video was rendered again.");
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).not.toBe("submitted");
    expect(w.adapter.submits).toHaveLength(0);
  });

  it("only a UiSession can approve (type level)", () => {
    // Never called: these lines exist so tsc fails if a plain object ever satisfies UiSession.
    const forged = () => {
      // @ts-expect-error a PAT/MCP handler has only ids, not a UiSession
      void approvePosts(db, { userId: "agent", workspaceId: "ws" }, []);
      // @ts-expect-error the email approve path takes a UiSession too
      void approveBroadcast(db, { userId: "agent", workspaceId: "ws" }, "id");
      // @ts-expect-error minting a session needs the Origin and CSRF checks to have passed
      void uiSessionFromCookie({ userId: "u", workspaceId: "ws" });
      // @ts-expect-error false is not a passed check
      void uiSessionFromCookie({ userId: "u", workspaceId: "ws", originChecked: false, csrfChecked: true });
    };
    expect(typeof forged).toBe("function");
  });

  it("only a UiSession can approve (runtime): no user or workspace, no session", () => {
    expect(() => uiSessionFromCookie({ userId: "", workspaceId: "ws", originChecked: true, csrfChecked: true })).toThrow(/signed-in UI session/);
    expect(() => uiSessionFromCookie({ userId: "u", workspaceId: "", originChecked: true, csrfChecked: true })).toThrow(/signed-in UI session/);
  });

  it("a session for another workspace can't approve this workspace's post", async () => {
    const w = await world(db);
    const other = await world(db);
    const id = await addPost(db, w.s, SLOT);
    const r = await approvePosts(db, sessionFor(other.s), [id], { now: w.clock.now });
    expect(r.approved).toHaveLength(0);
    expect(r.skipped).toEqual([{ postId: id, reason: "Post not found" }]);
    expect((await postRow(db, id)).state).toBe("pending_approval");
  });

  it("the approval records the approving user and the hash of what they saw", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    const [appr] = await db.select().from(schema.approvals).where(eq(schema.approvals.entityId, id));
    expect(appr!.approvedBy).toBe("user-1");
    expect(appr!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("submitted");
  });

  it.todo("approval POSTs from another origin or without the CSRF token are refused — apps/web route handlers (Playwright suite)");
});
