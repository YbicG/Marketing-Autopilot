import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { ensurePeriods } from "../cost/ledger.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { MODELS } from "./features.ts";
import { evalOne, loadEvalSamples, overridesLine, recommend, summarize, taskText, type EvalRow } from "./model-eval.ts";
import { fakeClient, jsonReply, text } from "./testing.ts";
import type { RateLookup } from "./usage.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
let ws: string;
let periods: string[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
  ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  periods = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 50_000_000 }]);
});
afterAll(() => close());

const row = (feature: EvalRow["feature"], candidate: string, outcome: EvalRow["outcome"], micros: number, base = 10_000): EvalRow => ({
  sampleId: uuidv7(),
  feature,
  candidate,
  outcome,
  candidateMicros: micros,
  baselineMicros: base,
});

describe("model eval scoring", () => {
  it("picks the cheapest candidate that holds up, never one with errors or too few samples", () => {
    const rows = [
      ...["win", "tie", "loss", "tie", "win"].map((o) => row("copy.bio", "openrouter:cheap", o as EvalRow["outcome"], 500)),
      ...["win", "win", "win", "win", "error"].map((o) => row("copy.bio", "openrouter:cheaper", o as EvalRow["outcome"], 100)),
      ...["loss", "loss", "loss", "tie", "loss"].map((o) => row("copy.bio", "openrouter:bad", o as EvalRow["outcome"], 50)),
      ...["win", "win"].map((o) => row("dna.gaps", "openrouter:cheap", o as EvalRow["outcome"], 100)),
    ];
    const s = summarize(rows);
    expect(s.find((x) => x.candidate === "openrouter:cheap" && x.feature === "copy.bio")).toMatchObject({ n: 5, wins: 2, ties: 2, losses: 1, score: 0.6, avgMicros: 500 });
    const picks = recommend(s);
    expect([...picks.keys()]).toEqual(["copy.bio"]);
    expect(overridesLine(picks)).toBe("copy.bio=openrouter:cheap");
  });

  it("the judge's task text marks images and is capped", () => {
    const t = taskText({ system: "S", messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] }, 25);
    expect(t).toContain("[…cut]");
    expect(taskText({ system: "S", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] })).toContain("[image]");
  });
});

describe("evalOne", () => {
  it("replays on the candidate, judges blind with the slot swapped, and loads samples per feature", async () => {
    await db.insert(schema.promptCaptures).values({
      id: uuidv7(),
      workspaceId: ws,
      feature: "copy.bio",
      provider: "anthropic",
      model: MODELS.sonnet,
      request: { system: "Write a bio.", messages: [{ role: "user", content: "SyllaCal" }] },
      output: "old bio",
      actualMicros: 9_000,
    });
    const [sample] = await loadEvalSamples(db, { perFeature: 5, features: ["copy.bio"] });
    expect(sample).toMatchObject({ feature: "copy.bio", output: "old bio" });

    const { client, calls } = fakeClient([{ content: [text("new bio")] }, jsonReply({ reasoning: "A is tighter", winner: "A" })]);
    const out = await evalOne({ db, rates, client, workspaceId: ws, budgetPeriodIds: periods }, sample!, { provider: "anthropic", model: MODELS.opus }, true);
    expect(calls[0]!.model).toBe(MODELS.opus);
    const judged = (calls[1]!.messages as { content: string }[])[0]!.content;
    expect(judged.indexOf("new bio")).toBeLessThan(judged.indexOf("old bio")); // candidate in slot A
    expect(calls[1]!.model).toBe(MODELS.opus);
    expect(out).toMatchObject({ outcome: "win", candidate: `anthropic:${MODELS.opus}`, baselineMicros: 9_000 });
    expect(out.candidateMicros).toBeGreaterThan(0);
  });
});
