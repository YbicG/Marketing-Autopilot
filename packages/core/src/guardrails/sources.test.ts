// §8 "Private and third-party sources": internal sources feed strategy only (never a public claim);
// pains are paraphrased without usernames; competitor review quotes never appear in ads.
import { describe, expect, it } from "vitest";
import type { AdCopy, FieldMetaMap, ProductDna, RecordPain } from "@mkt/contracts";
import { schema, uuidv7 } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { fakeClient, jsonReply, text, toolUse } from "../ai/testing.ts";
import { checkAdCopy, type AdsCheckCtx } from "../ads/validate.ts";
import { ensurePeriods } from "../cost/ledger.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { buildEvidenceBundle, claimIsPublic } from "../ingest/evidence.ts";
import { buildClaims } from "../ingest/profile.ts";
import { research, stripUsernames } from "../ingest/steps.ts";

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

  it("pains are stored without usernames, even when Claude leaves them in", async () => {
    expect(stripUsernames("u/jane_doe and /u/Sam-99 said it; @studyhacks agreed")).toBe("someone and someone said it; someone agreed");
    expect(stripUsernames("Email help@syllacal.com or post in r/college")).toBe("Email help@syllacal.com or post in r/college");

    const { db, close } = await createTestDb();
    try {
      await seedPricingRates(db);
      const ws = uuidv7();
      await db.insert(schema.workspaces).values({ id: ws, name: "t" });
      const budgetPeriodIds = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 50_000_000 }]);
      const url = "https://www.reddit.com/r/college/comments/abc";
      const { client } = fakeClient([
        { stop_reason: "tool_use", content: [toolUse("t1", "record_pain", { text: "u/jane_doe says typing every deadline in by hand takes all weekend", audience: "students", sourceUrl: url })] },
        { stop_reason: "end_turn", content: [text("done")] },
        jsonReply({ findings: [], competitors: [], pains: [{ text: "@studyhacks: syllabus week means copying dates for hours", audience: null, sourceUrl: url }] }),
      ]);
      const live: RecordPain[] = [];
      const out = await research(
        { ai: { db, rates: rateLookup(await loadRateCards(db)), client }, workspaceId: ws, budgetPeriodIds, runId: uuidv7() },
        {
          productBrief: "SyllaCal turns a syllabus into a calendar.",
          fetchText: async () => ({ ok: false }) as never,
          sink: { finding: async () => {}, competitor: async () => {}, pain: async (p) => void live.push(p) },
        },
      );
      expect(live.map((p) => p.text)).toEqual(["someone says typing every deadline in by hand takes all weekend"]);
      expect(out.pains.map((p) => p.text)).toEqual(["someone: syllabus week means copying dates for hours"]);
    } finally {
      await close();
    }
  });
});
