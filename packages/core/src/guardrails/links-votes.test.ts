// §8 "No invented links; no upvote requests": links only as {{link:landing}} tokens (raw URLs and
// unknown tokens stripped or blocked); asking for likes, upvotes or reposts blocks everywhere.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PostVariant } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { checkAdCopy } from "../ads/validate.ts";
import { validateBroadcast } from "../email/validate.ts";
import { saveTextVariant, syncDraftStates } from "../engine/editor.ts";
import { sanitizeVariant, UPVOTE_RE, validateVariant } from "../engine/validate.ts";
import { validateKitBody } from "../launch/kit/checks.ts";
import { approvePosts } from "../publishing/approvals.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { resolveLinkTokens } from "../publishing/links.ts";
import { addPost } from "../publishing/test-fixtures.ts";
import { approvedPost, postRow, sessionFor, SLOT, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const post = (over: Partial<PostVariant> = {}): PostVariant => ({
  platform: "threads",
  text: "Syllabus week, done.",
  parts: [],
  hashtags: [],
  linkToken: null,
  altText: null,
  firstComment: null,
  claimRefs: [],
  ...over,
});
const vctx = { platform: "threads" as const, format: "text" as const, scheduledAt: SLOT, claims: new Map(), recentTexts: [], xLinksAllowed: false };

describe("§8 No invented links", () => {
  it("drafts: typed web addresses and unknown link tokens are stripped; the landing token stays", () => {
    const r = sanitizeVariant(post({ text: "Get it at https://evil.example/x or www.evil.example {{link:pricing}} {{link:landing}}" }), vctx);
    expect(r.variant.text).not.toMatch(/evil|pricing/);
    expect(r.variant.text).toContain("{{link:landing}}");
    expect(r.variant.linkToken).toBe("{{link:landing}}");
    expect(r.issues.map((i) => i.code)).toEqual(["raw_link_removed"]);
  });

  it("publish time: an unknown link token blocks; a typed URL is reported (and blocks on launch day)", () => {
    const opts = { landingUrl: "https://syllacal.com/", utm: { utm_source: "threads" }, links: "clickable" as const };
    expect(resolveLinkTokens("Get it {{link:pricing}}", opts).problems).toEqual(['Unknown link "pricing". Only your website link can go in a post.']);
    expect(resolveLinkTokens("Get it https://evil.example", opts).warnings).toHaveLength(1);
    const ok = resolveLinkTokens("Get it {{link:landing}}", opts);
    expect(ok.problems).toEqual([]);
    expect(ok.text).toBe("Get it https://syllacal.com/?utm_source=threads");
  });

  it("publish time: a post carrying an unknown link token is held with the reason", async () => {
    const w = await world(db);
    const [v] = await db.select().from(schema.variants).where(eq(schema.variants.id, w.s.variantId));
    const body = structuredClone(v!.body) as { variant: { text: string; linkToken: string | null } };
    body.variant.text = "Get it {{link:pricing}}";
    body.variant.linkToken = null;
    await db.update(schema.variants).set({ body }).where(eq(schema.variants.id, w.s.variantId));
    const id = await approvedPost(w);
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toMatch(/Unknown link "pricing"/);
  });

  it("email: typed addresses and unknown tokens block", () => {
    const codes = validateBroadcast({
      subject: "Your spring semester, sorted",
      preheader: null,
      paragraphs: ["Try it: https://syllacal.com", "Or {{link:pricing}}"],
      claimRefs: [],
      settings: null,
      audienceId: null,
      scheduledAt: null,
      now: SLOT,
      claims: new Map(),
    }).map((i) => `${i.code}:${i.severity}`);
    expect(codes).toContain("raw_link:block");
    expect(codes).toContain("unknown_link:block");
  });
});

describe("§8 No upvote requests", () => {
  it.each(["Please upvote us on Product Hunt!", "Smash that like button", "RT if you agree", "Give us an upvote", "Drop a like"])("%s", (t) => {
    expect(UPVOTE_RE.test(t)).toBe(true);
  });

  it("ordinary copy isn't flagged", () => {
    expect(UPVOTE_RE.test("You'll like how fast it is. Share your syllabus and go.")).toBe(false);
  });

  it("blocks in posts, ads and launch kits", () => {
    expect(validateVariant(post({ text: "Launching today, please upvote!" }), vctx).map((i) => `${i.code}:${i.severity}`)).toContain("asks_for_votes:block");
    expect(validateVariant(post({ text: "ok", firstComment: "Smash that like button" }), vctx).map((i) => i.code)).toContain("asks_for_votes");
    const ad = { conceptIdx: 0, primaryText: "Please upvote us today", headline: "Sorted", description: null, callToAction: "Sign up", claimRefs: [] };
    expect(checkAdCopy(ad, "meta", { claims: new Map(), validThrough: SLOT, thirdPartyTexts: [] }, "a").issues.map((i) => i.code)).toContain("asks_for_votes");
    const kit = validateKitBody(
      { schemaVersion: 1, kind: "reply_bank", replies: [{ trigger: "Congrats!", reply: "Thanks! Please upvote it!", claimRefs: [] }] },
      { claims: new Map(), validThrough: SLOT, knownPrices: new Set(), competitors: [], inputs: {}, assetIds: new Set() },
    );
    expect(kit.map((i) => i.code)).toContain("asks_for_votes");
  });

  it("an editor save that asks for votes puts the post back in draft, so it can't be approved", async () => {
    const w = await world(db);
    const id = await addPost(db, w.s, SLOT);
    const saved = await saveTextVariant(db, w.s.workspaceId, w.s.variantId, { text: "Launch day! Please upvote us {{link:landing}}" }, w.clock.now);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.issues.map((i) => `${i.code}:${i.severity}`)).toContain("asks_for_votes:block");
    await syncDraftStates(db, w.s.workspaceId, w.s.variantId, w.clock.now);
    expect((await postRow(db, id)).state).toBe("draft");
    const r = await approvePosts(db, sessionFor(w.s), [id], { now: w.clock.now });
    expect(r.approved).toHaveLength(0);
  });
});
