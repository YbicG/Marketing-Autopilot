import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { ensurePeriods } from "../cost/ledger.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { callClaudeJson } from "./call.ts";
import { fakeClient, fakeUsage, jsonReply, text, toolUse } from "./testing.ts";
import { clientTool, runToolLoop } from "./tool-loop.ts";
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

const base = () => ({
  workspaceId: ws,
  budgetPeriodIds: periods,
  feature: "ingest.research" as const,
  system: "sys",
  messages: [{ role: "user" as const, content: "research this" }],
});

describe("runToolLoop", () => {
  it("resumes pause_turn without adding a user message, runs validated client tools, and bills every turn", async () => {
    const seen: unknown[] = [];
    const record = clientTool({
      name: "record_finding",
      description: "save",
      schema: z.object({ text: z.string().min(1) }),
      run: async (input) => {
        seen.push(input);
        return "saved";
      },
    });
    const { client, calls } = fakeClient([
      { stop_reason: "pause_turn", content: [text("searching…")], usage: { ...fakeUsage(1000, 10), server_tool_use: { web_search_requests: 3 } } as never },
      {
        stop_reason: "tool_use",
        content: [toolUse("t1", "record_finding", { text: "SyllaCal is one-time" }), toolUse("t2", "record_finding", { text: "" })],
      },
      { stop_reason: "end_turn", content: [text("done")] },
    ]);

    const out = await runToolLoop({ db, rates, client }, { ...base(), clientTools: [record] });

    expect(out.iterations).toBe(3);
    expect(out.pauseResumes).toBe(1);
    expect(out.stoppedEarly).toBe(false);
    expect(seen).toEqual([{ text: "SyllaCal is one-time" }]); // the empty one failed validation and never ran

    // Turn 2 = original user + paused assistant turn, nothing else.
    const turn2 = calls[1]!.messages as { role: string }[];
    expect(turn2.map((m) => m.role)).toEqual(["user", "assistant"]);
    // Turn 3 carries both tool results; the invalid one is an error result.
    const turn3 = calls[2]!.messages as { role: string; content: { is_error?: boolean }[] }[];
    const results = turn3.at(-1)!.content;
    expect(results).toHaveLength(2);
    expect(results[1]!.is_error).toBe(true);
    // Client tools carry eager_input_streaming; tools are sent every turn.
    expect((calls[0]!.tools as { eager_input_streaming?: boolean }[])[0]!.eager_input_streaming).toBe(true);

    const billed = await db.select().from(schema.providerCalls).where(eq(schema.providerCalls.workspaceId, ws));
    expect(billed.filter((c) => c.status === "settled")).toHaveLength(3);
    expect(billed.some((c) => c.serverToolFeesMicros === 30_000)).toBe(true); // 3 searches × $0.01
  });

  it("stops after maxPauseResumes", async () => {
    const paused = { stop_reason: "pause_turn" as const, content: [text("…")] };
    const { client } = fakeClient([paused, paused, paused]);
    const out = await runToolLoop({ db, rates, client }, { ...base(), clientTools: [], maxPauseResumes: 2 });
    expect(out).toMatchObject({ iterations: 3, pauseResumes: 2, stoppedEarly: true });
  });

  it("never runs tools from a refused turn", async () => {
    let ran = false;
    const t = clientTool({ name: "x", description: "x", schema: z.object({}), run: async () => ((ran = true), "") });
    const { client } = fakeClient([{ stop_reason: "refusal", content: [toolUse("t1", "x", {})] }]);
    await expect(runToolLoop({ db, rates, client }, { ...base(), clientTools: [t] })).rejects.toMatchObject({
      code: "blocked_by_policy",
    });
    expect(ran).toBe(false);
  });
});

describe("callClaudeJson", () => {
  const Out = z.object({ n: z.number().int().min(1) });

  it("repairs once with the zod issues", async () => {
    const { client, calls } = fakeClient([jsonReply({ n: 0 }), jsonReply({ n: 2 })]);
    const out = await callClaudeJson({ db, rates, client }, { ...base(), feature: "dna.gaps", schema: Out });
    expect(out.value).toEqual({ n: 2 });
    const repairMsgs = calls[1]!.messages as { role: string; content: string }[];
    expect(repairMsgs.at(-1)!.content).toContain("failed validation");
    expect((calls[0]!.output_config as { format?: unknown }).format).toBeDefined();
  });

  it("gives up after one repair", async () => {
    const { client } = fakeClient([jsonReply({ n: 0 }), jsonReply({ n: -1 })]);
    await expect(
      callClaudeJson({ db, rates, client }, { ...base(), feature: "dna.gaps", schema: Out }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});
