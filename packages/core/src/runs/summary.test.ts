import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { RunEvent } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { priceClaudeUsage } from "../cost/pricing.ts";
import { monthSpend } from "../cost/ledger.ts";
import type { RateLookup } from "../ai/usage.ts";
import { createSummaryRun, executeSummaryRun, type SummaryDeps } from "./summary.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
});
afterAll(() => close());

const SUMMARY = {
  name: "SyllaCal",
  oneLiner: "Turns a syllabus into calendar events.",
  whoItsFor: "College students",
  whatItDoes: ["Reads a syllabus PDF", "Exports every due date"],
  pricing: "One-time $4.99",
  notes: "",
};
const usage = { input_tokens: 3_000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fakeClient(calls: Record<string, unknown>[]): Anthropic {
  const stream = (params: Record<string, unknown>) => {
    calls.push(params);
    const s = new EventEmitter() as EventEmitter & { abort(): void; finalMessage(): Promise<unknown> };
    s.abort = () => undefined;
    s.finalMessage = async () => ({
      id: "msg_1",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(SUMMARY) }],
      usage,
    });
    return s;
  };
  return { messages: { stream }, beta: { messages: { stream } } } as unknown as Anthropic;
}

async function setup(limitMicros = 60_000_000) {
  const ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t", monthlyLimitMicros: limitMicros });
  const events: RunEvent[] = [];
  const calls: Record<string, unknown>[] = [];
  const deps: SummaryDeps = {
    db,
    rates,
    client: fakeClient(calls),
    publish: async (e) => events.push(e),
    fetchPage: async (url) => ({ finalUrl: url, title: "SyllaCal", text: "Upload your syllabus. $4.99 once." }),
  };
  return { ws, events, calls, deps };
}

describe("executeSummaryRun", () => {
  it("fetches, summarizes with structured output, bills the run, and completes", async () => {
    const { ws, events, calls, deps } = await setup();
    const runId = await createSummaryRun(db, ws, "https://syllacal.com");
    await executeSummaryRun(deps, runId);

    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run!.status).toBe("completed");
    expect(run!.result).toMatchObject({ summary: SUMMARY, servedModel: "claude-sonnet-5" });
    expect(calls[0]).toMatchObject({ output_config: { format: { type: "json_schema" } } });
    expect(events.map((e) => e.type)).toEqual([
      "stage_started",
      "fact_found",
      "stage_done",
      "stage_started",
      "cost_update",
      "stage_done",
      "artifact_ready",
      "run_completed",
    ]);

    const expected = priceClaudeUsage(usage, rates("claude-sonnet-5")).totalMicros;
    expect(run!.result!.spentMicros).toBe(expected);
    expect(await monthSpend(db, ws, 0)).toMatchObject({ spentMicros: expected, reservedMicros: 0, capMicros: 60_000_000 });
  });

  it("stops with a plain message when the monthly limit can't cover the call", async () => {
    const { ws, events, calls, deps } = await setup(10_000); // $0.01
    const runId = await createSummaryRun(db, ws, "https://syllacal.com");
    await executeSummaryRun(deps, runId);

    expect(calls).toHaveLength(0); // Claude was never called
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: "stage_failed", code: "budget_exceeded", retryable: false });
    expect((failed as { message: string }).message).toMatch(/spending limit/);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run!.status).toBe("failed");
  });

  it("ignores a duplicate delivery of a run that already started", async () => {
    const { ws, calls, deps } = await setup();
    const runId = await createSummaryRun(db, ws, "https://syllacal.com");
    await executeSummaryRun(deps, runId);
    await executeSummaryRun(deps, runId);
    expect(calls).toHaveLength(1);
  });
});
