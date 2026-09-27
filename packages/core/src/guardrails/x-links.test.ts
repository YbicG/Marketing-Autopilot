// §8 "X links" (D24): links on X only while the Upload-Post links add-on is on, i.e. inside the
// product's add-on window (at most 31 days). Outside it, drafts drop the link and publish-time
// blocks any link that's still there.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PostVariant } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { sanitizeVariant } from "../engine/validate.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { setXLinksWindow, validateXLinksWindow, X_LINKS_MAX_DAYS, xLinksAllowedOn } from "../publishing/x-links.ts";
import { approvedPost, LOCAL_DAY, postRow, world, type World } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const xPost = (text: string): PostVariant => ({ platform: "x", text, parts: [], hashtags: [], linkToken: null, altText: null, firstComment: null, claimRefs: [] });

async function setText(w: World, text: string) {
  const [v] = await db.select().from(schema.variants).where(eq(schema.variants.id, w.s.variantId));
  const body = v!.body as { variant: Record<string, unknown> };
  await db.update(schema.variants).set({ body: { ...body, variant: { ...body.variant, text } } }).where(eq(schema.variants.id, w.s.variantId));
}

describe("§8 X links", () => {
  it("links are allowed only inside the add-on window (or launch day ±3 when no window is set)", () => {
    const win = { xLinksFrom: "2026-10-18", xLinksUntil: "2026-10-24" };
    expect(xLinksAllowedOn(win, "2026-10-18")).toBe(true);
    expect(xLinksAllowedOn(win, "2026-10-25")).toBe(false);
    expect(xLinksAllowedOn({ xLinksFrom: null, xLinksUntil: null }, "2026-10-23", "2026-10-20")).toBe(true);
    expect(xLinksAllowedOn({ xLinksFrom: null, xLinksUntil: null }, "2026-10-24", "2026-10-20")).toBe(false);
    expect(xLinksAllowedOn({ xLinksFrom: null, xLinksUntil: null }, "2026-10-20")).toBe(false);
  });

  it("the window can be at most 31 days", async () => {
    expect(X_LINKS_MAX_DAYS).toBe(31);
    expect(validateXLinksWindow({ from: "2026-10-01", until: "2026-10-31" })).toBeNull();
    expect(validateXLinksWindow({ from: "2026-10-01", until: "2026-11-01" })).toMatch(/at most 31 days/);
    expect(validateXLinksWindow({ from: "2026-10-10", until: "2026-10-01" })).toMatch(/before the start/);
    const w = await world(db, { platform: "x" });
    expect(await setXLinksWindow(db, w.s.workspaceId, w.s.productId, { from: "2026-10-01", until: "2026-12-01" }, "user-1")).toMatchObject({ ok: false });
  });

  it("drafts: outside the window the link token is taken out of an X post", () => {
    const r = sanitizeVariant(xPost("Syllabus week, done. {{link:landing}}"), { platform: "x", xLinksAllowed: false });
    expect(r.variant.text).not.toContain("{{link:");
    expect(r.issues.map((i) => i.code)).toEqual(["x_link_outside_launch"]);
    expect(sanitizeVariant(xPost("Syllabus week, done. {{link:landing}}"), { platform: "x", xLinksAllowed: true }).variant.text).toContain("{{link:landing}}");
  });

  it("publish time: an X post with a link outside the window is held", async () => {
    const w = await world(db, { platform: "x" });
    await setText(w, "Syllabus week, done. {{link:landing}}");
    expect(await setXLinksWindow(db, w.s.workspaceId, w.s.productId, { from: "2026-10-21", until: "2026-10-27" }, "user-1")).toMatchObject({ ok: true });
    const id = await approvedPost(w, { platform: "x" });
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toBe("The X links add-on isn't on for Tue, Oct 20. Remove the link or set the add-on dates in Settings.");
  });

  it("publish time: inside the window the link goes out as a tracked link", async () => {
    const w = await world(db, { platform: "x" });
    await setText(w, "Syllabus week, done. {{link:landing}}");
    await setXLinksWindow(db, w.s.workspaceId, w.s.productId, { from: LOCAL_DAY, until: "2026-10-26" }, "user-1");
    const id = await approvedPost(w, { platform: "x" });
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("submitted");
    expect(w.adapter.submits[0]!.text).toMatch(/https:\/\/syllacal\.com\/\?utm_/);
  });
});
