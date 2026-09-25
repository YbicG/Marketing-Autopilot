import { describe, expect, it, vi } from "vitest";
import type { PostVariant } from "@mkt/contracts";
import { canonicalJson, variantContentHash } from "./hash.ts";
import { itemJobId } from "./package.ts";
import {
  UPVOTE_RE,
  claimIssues,
  ensurePlain,
  sanitizeVariant,
  trigramJaccard,
  validateVariant,
  type ClaimInfo,
  type ValidateContext,
} from "./validate.ts";

const claims = new Map<string, ClaimInfo>([
  ["C1", { ref: "C1", publicOk: true, status: "sourced", expiresAt: null }],
  ["C2", { ref: "C2", publicOk: false, status: "sourced", expiresAt: null }], // the internal scorecard stat
  ["C3", { ref: "C3", publicOk: true, status: "rejected", expiresAt: null }],
  ["C4", { ref: "C4", publicOk: true, status: "sourced", expiresAt: new Date("2026-10-15T00:00:00Z") }],
]);

const at = new Date("2026-10-20T23:30:00Z");
const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({
  platform: "x",
  format: "text",
  scheduledAt: at,
  claims,
  recentTexts: [],
  xLinksAllowed: true,
  ...over,
});
const post = (over: Partial<PostVariant> = {}): PostVariant => ({
  platform: "x",
  text: "Syllabus week, done in 15 seconds.",
  parts: [],
  hashtags: [],
  linkToken: null,
  altText: null,
  firstComment: null,
  claimRefs: ["C1"],
  ...over,
});
const codes = (v: PostVariant, c = ctx()) => validateVariant(v, c).map((i) => `${i.code}:${i.severity}`);

describe("platform limits", () => {
  it("X counts 280 with a link as 23", () => {
    const ok = post({ text: `${"a".repeat(280 - 24)} {{link:landing}}`, linkToken: "{{link:landing}}" });
    expect(codes(ok)).toEqual([]);
    const over = post({ text: `${"a".repeat(280 - 23)} {{link:landing}}` });
    expect(codes(over)).toContain("too_long:block");
  });
  it("counts hashtags against the caption and caps them per platform", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `tag${i}`);
    expect(codes(post({ platform: "instagram", hashtags: tags }), ctx({ platform: "instagram", format: "carousel" }))).toContain("too_many_hashtags:block");
    expect(codes(post({ platform: "threads", hashtags: ["a", "b"] }), ctx({ platform: "threads" }))).toContain("too_many_hashtags:block");
  });
  it("checks every part of a thread", () => {
    const v = post({ text: "one", parts: ["one", "x".repeat(300)] });
    expect(codes(v)).toContain("too_long:block");
  });
  it("Bluesky counts graphemes", () => {
    const v = post({ platform: "bluesky", text: "👩‍💻".repeat(300), claimRefs: [] });
    expect(codes(v, ctx({ platform: "bluesky" }))).toEqual([]);
  });
});

describe("similarity", () => {
  const prior = "Syllabus week, done in 15 seconds. Drop your PDF and every deadline lands in your calendar.";
  it("blocks near-duplicates on X and only warns elsewhere", () => {
    const v = post({ text: "Syllabus week, done in 15 seconds! Drop your PDF and every deadline lands in your calendar." });
    expect(trigramJaccard(v.text, prior)).toBeGreaterThan(0.6);
    expect(codes(v, ctx({ recentTexts: [prior] }))).toContain("too_similar:block");
    expect(codes({ ...v, platform: "threads" }, ctx({ platform: "threads", recentTexts: [prior] }))).toContain("too_similar:warn");
  });
  it("lets different posts through", () => {
    const v = post({ text: "Hell week is coming. See it three weeks early with every exam on one screen." });
    expect(trigramJaccard(v.text, prior)).toBeLessThan(0.6);
    expect(codes(v, ctx({ recentTexts: [prior] }))).not.toContain("too_similar:block");
  });
});

describe("output discipline", () => {
  it("blocks upvote requests", () => {
    expect(UPVOTE_RE.test("Please upvote if this helped")).toBe(true);
    expect(UPVOTE_RE.test("Smash that like button")).toBe(true);
    expect(UPVOTE_RE.test("Retweet if you've been there")).toBe(true);
    expect(UPVOTE_RE.test("I like how this looks")).toBe(false);
    expect(codes(post({ text: "Give it an upvote on PH!" }))).toContain("asks_for_votes:block");
  });
  it("strips raw URLs and keeps only the landing token", () => {
    const r = sanitizeVariant(post({ text: "Try it https://syllacal.com/?ref=x now {{link:pricing}} or www.syllacal.com {{link:landing}}" }), ctx());
    expect(r.variant.text).toBe("Try it now or {{link:landing}}");
    expect(r.variant.linkToken).toBe("{{link:landing}}");
    expect(r.issues.map((i) => i.code)).toEqual(["raw_link_removed"]);
  });
  it("drops X links outside launch week (D24)", () => {
    const r = sanitizeVariant(post({ text: "Out now {{link:landing}}", linkToken: "{{link:landing}}" }), ctx({ xLinksAllowed: false }));
    expect(r.variant.text).toBe("Out now");
    expect(r.variant.linkToken).toBeNull();
    expect(r.issues[0]!.code).toBe("x_link_outside_launch");
    // Other platforms keep it.
    const t = sanitizeVariant(post({ platform: "threads", text: "Out now {{link:landing}}" }), ctx({ platform: "threads", xLinksAllowed: false }));
    expect(t.variant.text).toBe("Out now {{link:landing}}");
  });
  it("strips # from hashtags", () => {
    expect(sanitizeVariant(post({ hashtags: ["#college", "college", "back to school"] }), ctx()).variant.hashtags).toEqual(["college", "backtoschool"]);
  });
});

describe("claims", () => {
  it("rejects internal (scorecard), rejected, unknown and expiring facts", () => {
    expect(claimIssues(["C1"], claims, at)).toEqual([]);
    expect(claimIssues(["C2"], claims, at)[0]!.code).toBe("internal_fact");
    expect(claimIssues(["C3"], claims, at)[0]!.code).toBe("rejected_fact");
    expect(claimIssues(["C9"], claims, at)[0]!.code).toBe("unknown_fact");
    expect(claimIssues(["C4"], claims, at)[0]!.code).toBe("fact_expires");
    // Valid through an earlier slot.
    expect(claimIssues(["C4"], claims, new Date("2026-10-10T00:00:00Z"))).toEqual([]);
    expect(codes(post({ claimRefs: ["C2"] }))).toContain("internal_fact:block");
  });
  it("warns on numbers with no source", () => {
    expect(codes(post({ claimRefs: [], text: "94% of syllabi right" }))).toContain("number_without_source:warn");
  });
});

describe("jargon (§2.6)", () => {
  it("one rewrite, then swap", async () => {
    const stillBad = vi.fn(async () => "Your CTA and hook are strong.");
    const r = await ensurePlain("Great hook, weak CTA.", "ui", stillBad);
    expect(stillBad).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ text: "Your what you want them to do next and opening line are strong.", rewritten: true, swapped: true });

    const fixes = vi.fn(async () => "Great opening line, weak ending.");
    expect(await ensurePlain("Great hook, weak CTA.", "ui", fixes)).toEqual({ text: "Great opening line, weak ending.", rewritten: true, swapped: false });

    const never = vi.fn(async () => "");
    expect((await ensurePlain("All plain.", "ui", never)).rewritten).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
  it("flags post jargon as a warning", () => {
    expect(codes(post({ text: "Our CTA: sign up", claimRefs: [] }))).toContain("jargon:warn");
  });
});

describe("ids and hashes", () => {
  it("job ids fit BullMQ's colon rule", () => {
    const id = itemJobId("0192-abc", "post:text-07");
    expect(id.split(":")).toHaveLength(3);
    expect(() => itemJobId("r", "post:a:b")).toThrow();
  });
  it("hashes canonically", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(variantContentHash({ platform: "x", body: { a: 1, b: 2 } })).toBe(variantContentHash({ platform: "x", body: { b: 2, a: 1 } }));
    expect(variantContentHash({ platform: "x", body: { a: 1 } })).not.toBe(variantContentHash({ platform: "threads", body: { a: 1 } }));
  });
});
