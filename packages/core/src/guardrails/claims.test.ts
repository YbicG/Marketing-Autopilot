// §8 "No fake testimonials, reviews or numbers" (FTC 16 CFR 465): claimRefs must be public_ok;
// testimonials need a verified source (and a date and consent); numbers need a fact behind them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PostVariant } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { checkAdCopy, type AdsCheckCtx } from "../ads/validate.ts";
import { validateBroadcast } from "../email/validate.ts";
import { claimIssues, validateVariant, type ClaimInfo } from "../engine/validate.ts";
import { validateKitBody } from "../launch/kit/checks.ts";
import { claimProblem } from "../publishing/claims.ts";
import { handlePublishDue } from "../publishing/due.ts";
import { pendingDnaChanges } from "../tools/dna-changes.ts";
import { invokeTool } from "../tools/invoke.ts";
import { TOOL_MAP, TOOLS } from "../tools/mcp.ts";
import { mintPat, verifyPat } from "../tools/pat.ts";
import { approvedPost, postRow, sessionFor, SLOT, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const claims = new Map<string, ClaimInfo>([
  ["C1", { ref: "C1", publicOk: true, status: "sourced", expiresAt: null }],
  ["C2", { ref: "C2", publicOk: false, status: "sourced", expiresAt: null }],
  ["C3", { ref: "C3", publicOk: true, status: "rejected", expiresAt: null }],
]);
const post = (over: Partial<PostVariant> = {}): PostVariant => ({
  platform: "threads",
  text: "Syllabus week, done.",
  parts: [],
  hashtags: [],
  linkToken: null,
  altText: null,
  firstComment: null,
  claimRefs: ["C1"],
  ...over,
});
const vctx = { platform: "threads" as const, format: "text" as const, scheduledAt: SLOT, claims, recentTexts: [], xLinksAllowed: false };
const codes = (issues: { code: string; severity: string }[]) => issues.map((i) => `${i.code}:${i.severity}`);

describe("§8 No fake testimonials, reviews or numbers", () => {
  it("drafts: only public, unrejected, known facts can be cited", () => {
    expect(codes(validateVariant(post(), vctx))).toEqual([]);
    expect(codes(validateVariant(post({ claimRefs: ["C2"] }), vctx))).toContain("internal_fact:block");
    expect(codes(validateVariant(post({ claimRefs: ["C3"] }), vctx))).toContain("rejected_fact:block");
    expect(codes(validateVariant(post({ claimRefs: ["C9"] }), vctx))).toContain("unknown_fact:block");
  });

  it("drafts: a number with no fact behind it is flagged", () => {
    expect(codes(validateVariant(post({ text: "Saves students 10 hours a week.", claimRefs: [] }), vctx))).toContain("number_without_source:warn");
    const adCtx: AdsCheckCtx = { claims: new Map(), validThrough: SLOT, thirdPartyTexts: [] };
    const ad = { conceptIdx: 0, primaryText: "Save 10 hours this semester.", headline: "Sorted", description: null, callToAction: "Sign up", claimRefs: [] };
    expect(checkAdCopy(ad, "meta", adCtx, "Meta ad").issues.map((i) => i.code)).toContain("number_without_source");
  });

  it("publish time: a claim that stopped being public sends the approved post back", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await db.update(schema.claims).set({ publicOk: false }).where(eq(schema.claims.id, w.s.claimId));
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).staleReason).toMatch(/isn't public/);
  });

  it("publish time: an unverified testimonial can't go out", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await db.update(schema.claims).set({ kind: "testimonial", status: "sourced" }).where(eq(schema.claims.id, w.s.claimId));
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("pending_approval");
    expect((await postRow(db, id)).staleReason).toMatch(/testimonial this post uses isn't verified/);
  });

  it("every other outlet blocks an unverified testimonial: ads, email, launch kits", () => {
    const adCtx: AdsCheckCtx = {
      claims: new Map([["C5", { ref: "C5", kind: "testimonial", text: "Love it", quote: null, publicOk: true, status: "sourced", expiresAt: null }]]),
      validThrough: SLOT,
      thirdPartyTexts: [],
    };
    const ad = { conceptIdx: 0, primaryText: "Students love it.", headline: "Sorted", description: null, callToAction: "Sign up", claimRefs: ["C5"] };
    expect(checkAdCopy(ad, "meta", adCtx, "a").issues.map((i) => i.code)).toContain("testimonial_unverified");

    const email = validateBroadcast({
      subject: "Your spring semester, sorted",
      preheader: null,
      paragraphs: ["Students love it."],
      claimRefs: ["C5"],
      settings: null,
      audienceId: null,
      scheduledAt: null,
      now: SLOT,
      claims: new Map([["C5", { ref: "C5", kind: "testimonial", publicOk: true, status: "sourced", expiresAt: null }]]),
    });
    expect(email.map((i) => i.code)).toContain("unverified_testimonial");

    const kit = validateKitBody(
      { schemaVersion: 1, kind: "reply_bank", replies: [{ trigger: "Is it good?", reply: "People love it.", claimRefs: ["C5"] }] },
      {
        claims: new Map([["C5", { ref: "C5", kind: "testimonial", publicOk: true, status: "sourced", expiresAt: null }]]),
        validThrough: SLOT,
        knownPrices: new Set(),
        competitors: [],
        inputs: {},
        assetIds: new Set(),
      },
    );
    expect(kit.map((i) => i.code)).toContain("unverified_testimonial");
  });

  it("drafts flag an unverified testimonial before approval (engine/validate.ts:151)", () => {
    const withKind = new Map([["C5", { ref: "C5", publicOk: true, status: "sourced" as const, expiresAt: null, kind: "testimonial" }]]);
    expect(claimIssues(["C5"], withKind, SLOT).map((i) => i.code)).toContain("unverified_testimonial");
  });

  it("a testimonial marked verified with nobody on record as the verifier is still blocked (publishing/claims.ts:21)", () => {
    const row = {
      id: "c",
      workspaceId: "w",
      productId: "p",
      dnaVersionId: "d",
      ref: "C5",
      kind: "testimonial" as const,
      text: "Saved my semester",
      quote: null,
      sourceRefs: ["S1"],
      publicOk: true,
      status: "verified" as const,
      verifiedBy: null,
      expiresAt: null,
      createdAt: new Date(),
    };
    expect(claimProblem(row, row, { scheduledAt: SLOT, now: SLOT }, true)).not.toBeNull();
  });

  it.todo("testimonials carry a source date and the person's consent — GAP: claims has no date/consent columns (packages/db/src/schema.ts:462); needs a schema change");
  it.todo("only a UI session can verify a claim — GAP: no claim-verification action exists yet (planned with the M5 tool registry; must take a UiSession like approvePosts)");
  it("agent edits to claims become pending requests: propose_dna_change changes nothing until the owner accepts (tools/dna-changes.ts)", async () => {
    const w = await world(db);
    const ui = sessionFor(w.s);
    const { token } = await mintPat(db, ui, { name: "agent", scopes: ["read", "draft"] }, SLOT);
    const pat = (await verifyPat(db, token, SLOT))!;
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, w.s.productId));
    const proof = [{ kind: "testimonial", text: "Saved my semester", sourceIds: ["S1"], quote: "Saved my semester" }];
    const r = await invokeTool({ pat, deps: { db, baseUrl: "https://mkt.example.com", confirmSecret: () => "", enqueueOrchestrate: async () => {}, now: () => SLOT }, tools: TOOL_MAP }, "propose_dna_change", {
      product: product!.slug,
      path: "offer.proof",
      value: proof,
    });
    expect(r.status).toBe("ok");
    const before = await db.select().from(schema.claims).where(eq(schema.claims.dnaVersionId, w.s.dnaVersionId));
    expect(before.map((c) => c.ref)).toEqual(["C1"]);
    const [dna] = await db.select().from(schema.productDnaVersions).where(eq(schema.productDnaVersions.id, w.s.dnaVersionId));
    expect((dna!.dna as { offer?: { proof?: unknown } }).offer?.proof).toBeUndefined();
    const reqs = await pendingDnaChanges(db, w.s.workspaceId, w.s.productId);
    expect(reqs.map((x) => [x.path, x.status, x.patId])).toEqual([["offer.proof", "pending", pat.patId]]);
    // No tool can accept it; the accept action takes a UiSession, which a token never becomes.
    expect(TOOLS.some((t) => /accept|verify/.test(t.name))).toBe(false);
  });
});
