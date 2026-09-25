import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { ensurePeriods } from "../cost/ledger.ts";
import { priceClaudeUsage } from "../cost/pricing.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { callClaudeText, FALLBACK_BETA } from "./call.ts";
import { ClaudeRefused } from "./stop-reasons.ts";
import { StreamStalled, withWatchdog } from "./stream-watchdog.ts";
import { BANNED_SCHEMA_KEYWORDS, claudeFormat } from "./structured.ts";
import { priceMessage, type RateLookup } from "./usage.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  await seedPricingRates(db); // idempotent
  rates = rateLookup(await loadRateCards(db));
});
afterAll(() => close());

// ── fakes ──

class FakeStream extends EventEmitter {
  aborted = false;
  constructor(
    private readonly msg: Partial<Anthropic.Message> | null,
    private readonly delayMs = 0,
  ) {
    super();
  }
  abort() {
    this.aborted = true;
    this.emit("abort");
  }
  finalMessage(): Promise<Anthropic.Message> {
    return new Promise((resolve, reject) => {
      if (!this.msg) {
        this.once("abort", () => reject(new Error("Request was aborted.")));
        return;
      }
      setTimeout(() => {
        this.emit("streamEvent");
        resolve(this.msg as Anthropic.Message);
      }, this.delayMs);
    });
  }
}

function fakeClient(replies: Partial<Anthropic.Message>[]) {
  const calls: Record<string, unknown>[] = [];
  const next = (params: Record<string, unknown>) => {
    calls.push(params);
    const r = replies.shift();
    if (!r) throw new Error("no more fake replies");
    return new FakeStream({ id: `msg_${calls.length}`, type: "message", role: "assistant", ...r });
  };
  const client = { messages: { stream: next }, beta: { messages: { stream: next } } } as unknown as Anthropic;
  return { client, calls };
}

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

async function workspaceWithBudget(capMicros = 5_000_000) {
  const ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  const ids = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros }]);
  return { ws, ids };
}

// ── tests ──

describe("claudeFormat", () => {
  it("strips every keyword the API rejects and closes objects", () => {
    const S = z.object({
      name: z.string().min(1).max(80),
      score: z.number().int().min(0).max(10),
      tags: z.array(z.string()).min(1).max(5),
      pattern: z.string().regex(/^[a-z]+$/), // a property literally called "pattern" must survive
      nested: z.object({ at: z.iso.datetime(), n: z.number().nullable() }),
    });
    const { schema: out } = claudeFormat(S);
    const text = JSON.stringify(out);
    for (const kw of BANNED_SCHEMA_KEYWORDS.filter((k) => k !== "pattern")) expect(text).not.toContain(`"${kw}"`);
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toContain("pattern");
    expect(props.pattern).not.toHaveProperty("pattern");
    expect(out.additionalProperties).toBe(false);
    expect(props.nested!.additionalProperties).toBe(false);
  });
});

describe("priceMessage", () => {
  it("bills each fallback attempt at its own model and skips a pre-output decline", () => {
    const priced = priceMessage(
      {
        model: "claude-opus-5",
        usage: {
          ...usage(1_000, 500),
          iterations: [
            { type: "message", model: "claude-sonnet-5", ...usage(1_000, 0) },
            { type: "fallback_message", model: "claude-opus-5", ...usage(1_000, 500) },
          ],
        },
      },
      rates,
    );
    expect(priced.actualMicros).toBe(priceClaudeUsage(usage(1_000, 500), rates("claude-opus-5")).totalMicros);
    expect(priced.servedModel).toBe("claude-opus-5");
  });
});

describe("withWatchdog", () => {
  it("aborts a silent stream with StreamStalled", async () => {
    const s = new FakeStream(null);
    await expect(withWatchdog(s, 20)).rejects.toBeInstanceOf(StreamStalled);
    expect(s.aborted).toBe(true);
  });
});

describe("callClaudeText", () => {
  it("settles the ledger at usage × pricing_rates of the served model", async () => {
    const { ws, ids } = await workspaceWithBudget();
    const { client, calls } = fakeClient([
      { model: "claude-sonnet-5", stop_reason: "end_turn", content: [{ type: "text", text: "Hello" } as Anthropic.TextBlock], usage: usage(2_000, 300) as Anthropic.Usage },
    ]);
    const out = await callClaudeText(
      { db, rates, client },
      { workspaceId: ws, budgetPeriodIds: ids, feature: "m0.summary", system: "sys", messages: [{ role: "user", content: "hi" }] },
    );
    expect(out.text).toBe("Hello");
    expect(calls[0]).toMatchObject({ model: "claude-sonnet-5", thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(calls[0]).not.toHaveProperty("betas");

    const [row] = await db.select().from(schema.providerCalls).where(eq(schema.providerCalls.id, out.callIds[0]!));
    expect(row).toMatchObject({
      status: "settled",
      servedModel: "claude-sonnet-5",
      actualMicros: priceClaudeUsage(usage(2_000, 300), rates("claude-sonnet-5")).totalMicros,
    });
  });

  it("sends the fallback beta on Opus features only", async () => {
    const { ws, ids } = await workspaceWithBudget();
    const { client, calls } = fakeClient([
      { model: "claude-opus-5", stop_reason: "end_turn", content: [], usage: usage(10, 10) as Anthropic.Usage },
    ]);
    await callClaudeText(
      { db, rates, client },
      { workspaceId: ws, budgetPeriodIds: ids, feature: "dna.one_liner", system: "s", messages: [{ role: "user", content: "x" }] },
    );
    expect(calls[0]).toMatchObject({ betas: [FALLBACK_BETA], fallbacks: "default" });
  });

  it("bills and throws a refusal; retries max_tokens once at double the limit", async () => {
    const { ws, ids } = await workspaceWithBudget();
    const refuse = fakeClient([
      { model: "claude-sonnet-5", stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } as never, content: [], usage: usage(100, 20) as Anthropic.Usage },
    ]);
    await expect(
      callClaudeText(
        { db, rates, client: refuse.client },
        { workspaceId: ws, budgetPeriodIds: ids, feature: "m0.summary", system: "s", messages: [{ role: "user", content: "x" }] },
      ),
    ).rejects.toBeInstanceOf(ClaudeRefused);

    const trunc = fakeClient([
      { model: "claude-sonnet-5", stop_reason: "max_tokens", content: [], usage: usage(100, 4_000) as Anthropic.Usage },
      { model: "claude-sonnet-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" } as Anthropic.TextBlock], usage: usage(100, 5_000) as Anthropic.Usage },
    ]);
    const out = await callClaudeText(
      { db, rates, client: trunc.client },
      { workspaceId: ws, budgetPeriodIds: ids, feature: "m0.summary", system: "s", messages: [{ role: "user", content: "x" }] },
    );
    expect(out.text).toBe("ok");
    expect(trunc.calls[1]).toMatchObject({ max_tokens: 8_000 });

    const [p] = await db.select().from(schema.budgetPeriods).where(eq(schema.budgetPeriods.id, ids[0]!));
    const sonnet = rates("claude-sonnet-5");
    const expected =
      priceClaudeUsage(usage(100, 20), sonnet).totalMicros +
      priceClaudeUsage(usage(100, 4_000), sonnet).totalMicros +
      priceClaudeUsage(usage(100, 5_000), sonnet).totalMicros;
    expect(p).toMatchObject({ reservedMicros: 0, spentMicros: expected });
  });
});
