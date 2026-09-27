// §8 "Private and third-party sources": internal sources feed strategy only (never a public claim);
// pains are paraphrased without usernames; competitor review quotes never appear in ads.
import { describe, expect, it } from "vitest";
import type { AdCopy, FieldMetaMap, ProductDna } from "@mkt/contracts";
import { checkAdCopy, type AdsCheckCtx } from "../ads/validate.ts";
import { buildEvidenceBundle, claimIsPublic } from "../ingest/evidence.ts";
import { buildClaims } from "../ingest/profile.ts";

const artifacts = [
  {
    artifactId: "a1",
    sourceId: "site",
    sourceKind: "website",
    kind: "page",
    title: "SyllaCal",
    url: "https://syllacal.com/",
    path: null,
    visibility: "public_ok" as const,
    text: "SyllaCal turns your syllabus into a calendar in 15 seconds. Basic $4.99 one-time.",
  },
  {
    artifactId: "a2",
    sourceId: "folder",
    sourceKind: "folder_upload",
    kind: "doc",
    title: "docs/scorecard.md",
    url: null,
    path: "docs/scorecard.md",
    visibility: "internal" as const,
    text: "Internal scorecard: 1,212 paying students so far. The parser gets 94% right.",
  },
];
const bundle = buildEvidenceBundle({
  productName: "SyllaCal",
  artifacts,
  research: [{ id: "r1", kind: "competitor", text: "Notion templates are free but manual", sourceUrl: "https://example.com/review" }],
  assets: [],
  answers: [{ question: "How many users?", answer: "About 1,200 paying students" }],
});

describe("§8 Private and third-party sources", () => {
  it("the bundle labels internal sources as internal", () => {
    expect(bundle.sourceMap.S1!.origin).toBe("owned_public");
    expect(bundle.sourceMap.S2!.origin).toBe("owned_internal");
    expect(bundle.markdown).toContain("## S2 · INTERNAL");
    // The developer's own answers are internal too.
    expect(Object.values(bundle.sourceMap).find((s) => s.title === "Your answers")!.origin).toBe("owned_internal");
  });

  it("an internal-only fact is never public, whatever the model cites", () => {
    const stat = { kind: "stat" as const, text: "1,212 paying students", quote: "1,212 paying students" };
    expect(claimIsPublic({ ...stat, sourceIds: ["S2"] }, bundle)).toBe(false);
    // Citing the public site as well doesn't launder it: the site doesn't say it.
    expect(claimIsPublic({ ...stat, sourceIds: ["S1", "S2"] }, bundle)).toBe(false);
    expect(claimIsPublic({ ...stat, sourceIds: ["S1"] }, bundle)).toBe(false);
  });

  it("third-party pages back comparisons only", () => {
    const research = Object.entries(bundle.sourceMap).find(([, s]) => s.origin === "third_party")![0];
    expect(claimIsPublic({ kind: "comparison", text: "Notion templates are free but manual", quote: null, sourceIds: [research] }, bundle)).toBe(true);
    expect(claimIsPublic({ kind: "feature", text: "Notion templates are free but manual", quote: null, sourceIds: [research] }, bundle)).toBe(false);
  });

  it("claims built at ingest carry publicOk from the source rule", () => {
    const dna = {
      offer: {
        proof: [
          { kind: "stat", text: "1,212 paying students", quote: "1,212 paying students", sourceIds: ["S2"] },
          { kind: "feature", text: "Syllabus to calendar in 15 seconds", quote: "turns your syllabus into a calendar in 15 seconds", sourceIds: ["S1"] },
        ],
        pricing: { tiers: [] },
      },
    } as unknown as ProductDna;
    const built = buildClaims(dna, {} as FieldMetaMap, bundle, new Date("2026-10-01T00:00:00Z"));
    expect(built.map((c) => [c.kind, c.publicOk])).toEqual([
      ["stat", false],
      ["feature", true],
    ]);
  });

  it("ads never quote reviews or reuse third-party wording", () => {
    const pain = "Typing deadlines in by hand takes hours every single week";
    const ctx: AdsCheckCtx = { claims: new Map(), validThrough: new Date("2026-11-04T00:00:00Z"), thirdPartyTexts: [pain] };
    const copy = (primaryText: string): AdCopy => ({ conceptIdx: 0, primaryText, headline: "Sorted", description: null, callToAction: "Sign up", claimRefs: [] });
    const codes = (t: string) => checkAdCopy(copy(t), "meta", ctx, "Meta ad").issues.map((i) => `${i.code}:${i.severity}`);
    expect(codes('One review says "this app changed my whole semester" and we agree.')).toContain("quote_in_ad:block");
    expect(codes("Sick of it? typing deadlines in by hand takes hours every week.")).toContain("third_party_text:block");
    expect(codes("Drop your syllabus in, get your semester back.")).toEqual([]);
  });

  it.todo(
    "pains are stored without usernames — GAP: prompt-only (ingest/steps.ts:164); no code strips u/name or @handle from research pains before they're saved (fix at ingest/steps.ts:171)",
  );
});
