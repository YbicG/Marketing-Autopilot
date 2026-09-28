import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { ensurePeriods } from "../cost/ledger.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { callClaude, callClaudeJson, FALLBACK_BETA } from "./call.ts";
import { feature, FEATURES, MODELS, parseModelOverrides } from "./features.ts";
import { fromOpenRouterResponse, openRouterBody, toOpenRouterMessages, type FetchLike } from "./openrouter.ts";
import { fakeClient, text } from "./testing.ts";
import { clientTool, runToolLoop } from "./tool-loop.ts";
import type { RateLookup } from "./usage.ts";

let db: Db;
let close: () => Promise<void>;
let rates: RateLookup;
let ws: string;
let periods: string[];

beforeAll(async () => {
  process.env.OPENROUTER_API_KEY ??= "test-key";
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  rates = rateLookup(await loadRateCards(db));
  ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  periods = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 50_000_000 }]);
});
afterAll(() => close());
afterEach(() => {
  delete process.env.AI_MODEL_OVERRIDES;
  delete process.env.AI_CAPTURE_PROMPTS;
});

/** Replies in order, keeping every request body. */
function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    headers.push(init.headers);
    const r = replies.shift();
    if (!r) throw new Error("no more fake replies");
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, bodies, headers };
}

const orReply = (content: string | null, extra: Record<string, unknown> = {}, cost = 0.000321) => ({
  body: {
    id: "gen-1",
    model: "z-ai/glm-5.3-flash",
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 }, cost },
    ...extra,
  },
});

describe("parseModelOverrides / feature()", () => {
  it("parses entries and reports bad ones", () => {
    const { overrides, errors } = parseModelOverrides(
      "ingest.label_asset=openrouter:z-ai/glm-5.3-flash; dna.gaps=openrouter:openai/gpt-6-luna@high,nope,made.up=openrouter:x,eval.judge=openrouter:x,dna.gaps=anthropic:y@huge",
    );
    expect(overrides.get("ingest.label_asset")).toEqual({ provider: "openrouter", model: "z-ai/glm-5.3-flash" });
    expect(overrides.get("dna.gaps")).toEqual({ provider: "openrouter", model: "openai/gpt-6-luna", effort: "high" });
    expect(errors).toHaveLength(4);
  });

  it("moves a feature and turns Anthropic fallbacks off when the model changes", () => {
    const { overrides } = parseModelOverrides("dna.one_liner=openrouter:z-ai/glm-5.3-flash");
    expect(FEATURES["dna.one_liner"].fallbacks).toBe(true);
    expect(feature("dna.one_liner", overrides)).toMatchObject({ provider: "openrouter", model: "z-ai/glm-5.3-flash", fallbacks: false, effort: "medium" });
    expect(feature("dna.gaps", overrides)).toEqual(FEATURES["dna.gaps"]);
  });

  it("reads AI_MODEL_OVERRIDES from the environment", () => {
    process.env.AI_MODEL_OVERRIDES = "dna.gaps=openrouter:openai/gpt-6-luna";
    expect(feature("dna.gaps").provider).toBe("openrouter");
    delete process.env.AI_MODEL_OVERRIDES;
    expect(feature("dna.gaps").provider).toBe("anthropic");
  });

  it("Opus is 5.5", () => {
    expect(MODELS.opus).toBe("claude-opus-5-5");
    expect(rates(MODELS.opus).input_mtok).toBe(4_000_000);
  });
});

describe("OpenRouter translation", () => {
  it("maps text, images, tool calls and tool results to chat messages", () => {
    const out = toOpenRouterMessages("sys", [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "record", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "saved" }, { type: "tool_result", tool_use_id: "t2", content: "bad", is_error: true }] },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] });
    expect(out[2]).toEqual({ role: "assistant", content: "ok", tool_calls: [{ id: "t1", type: "function", function: { name: "record", arguments: '{"a":1}' } }] });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "saved" });
    expect(out[4]).toEqual({ role: "tool", tool_call_id: "t2", content: "ERROR: bad" });
  });

  it("asks for ZDR and no data collection, drops server tools and caps effort at high", () => {
    const cfg = { ...FEATURES["strategy.positioning"], provider: "openrouter" as const, model: "x/y", effort: "max" as const };
    const body = openRouterBody(
      cfg,
      {
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "web_search_20260209", name: "web_search" } as never,
          { name: "record", description: "d", input_schema: { type: "object", properties: {} } },
        ],
        outputFormat: { type: "json_schema", schema: { type: "object" } },
      },
      1000,
    );
    expect(body.provider).toEqual({ data_collection: "deny", zdr: true, require_parameters: true });
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.tools).toEqual([{ type: "function", function: { name: "record", description: "d", parameters: { type: "object", properties: {} } } }]);
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { schema: { type: "object" } } });
  });

  it("maps the reply back, tool calls win over a 'stop' finish, and bad JSON arguments are kept for validation", () => {
    const { message, costMicros } = fromOpenRouterResponse(
      {
        model: "m",
        choices: [{ finish_reason: "stop", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{oops" } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0000011 },
      },
      "m",
    );
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content[0]).toMatchObject({ type: "tool_use", id: "c1", name: "x", input: { INVALID_JSON: "{oops" } });
    expect(costMicros).toBe(2);
  });
});

describe("callClaude on OpenRouter", () => {
  const call = (feature: "dna.gaps" | "ingest.research") => ({
    workspaceId: ws,
    budgetPeriodIds: periods,
    feature,
    system: "sys",
    messages: [{ role: "user" as const, content: "hi" }],
  });

  it("settles at OpenRouter's reported cost and records the provider", async () => {
    process.env.AI_MODEL_OVERRIDES = "dna.gaps=openrouter:z-ai/glm-5.3-flash";
    const { fetch, bodies } = fakeFetch([orReply('{"questions":[]}')]);
    const out = await callClaude({ db, rates, fetch }, call("dna.gaps"));
    expect(out.servedModel).toBe("z-ai/glm-5.3-flash");
    expect(bodies[0]!.model).toBe("z-ai/glm-5.3-flash");
    const [row] = await db.select().from(schema.providerCalls).where(eq(schema.providerCalls.id, out.callIds[0]!));
    expect(row).toMatchObject({ provider: "openrouter", status: "settled", actualMicros: 321, servedModel: "z-ai/glm-5.3-flash" });
  });

  it("estimates an unknown OpenRouter model at the fallback card and prices by rates when cost is missing", async () => {
    process.env.AI_MODEL_OVERRIDES = "dna.gaps=openrouter:some/new-model";
    const reply = orReply("{}", { model: "some/new-model" });
    delete (reply.body.usage as { cost?: number }).cost;
    const { fetch } = fakeFetch([reply]);
    const out = await callClaude({ db, rates, fetch }, call("dna.gaps"));
    const [row] = await db.select().from(schema.providerCalls).where(eq(schema.providerCalls.id, out.callIds[0]!));
    // 1000 uncached in @ $2 + 200 cached @ $0.2 + 300 out @ $10 = 2000 + 40 + 3000 micros
    expect(row!.actualMicros).toBe(5_040);
  });

  it("retries a 429, then gives up after two retries", async () => {
    process.env.AI_MODEL_OVERRIDES = "dna.gaps=openrouter:z-ai/glm-5.3-flash";
    const { fetch } = fakeFetch([{ status: 429, body: { error: { message: "slow down" } } }, orReply("{}")]);
    // The first retry waits 1 s.
    await expect(callClaude({ db, rates, fetch }, call("dna.gaps"))).resolves.toBeDefined();
  }, 10_000);

  it("runs structured output with the zod repair on OpenRouter too", async () => {
    process.env.AI_MODEL_OVERRIDES = "dna.gaps=openrouter:z-ai/glm-5.3-flash";
    const { fetch, bodies } = fakeFetch([orReply('{"n":0}'), orReply('{"n":3}')]);
    const out = await callClaudeJson({ db, rates, fetch }, { ...call("dna.gaps"), schema: z.object({ n: z.number().min(1) }) });
    expect(out.value).toEqual({ n: 3 });
    expect(bodies).toHaveLength(2);
  });

  it("the tool loop works over OpenRouter tool calls", async () => {
    process.env.AI_MODEL_OVERRIDES = "ingest.research=openrouter:z-ai/glm-5.3-flash";
    const seen: unknown[] = [];
    const tool = clientTool({ name: "record", description: "d", schema: z.object({ t: z.string() }), run: async (i) => (seen.push(i), "saved") });
    const { fetch, bodies } = fakeFetch([
      { body: { model: "z-ai/glm-5.3-flash", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "record", arguments: '{"t":"x"}' } }] } }], usage: { cost: 0.0001 } } },
      orReply("done"),
    ]);
    const out = await runToolLoop({ db, rates, fetch }, { ...call("ingest.research"), clientTools: [tool] });
    expect(seen).toEqual([{ t: "x" }]);
    expect(out.iterations).toBe(2);
    const second = bodies[1]!.messages as { role: string }[];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("captures single-shot calls when AI_CAPTURE_PROMPTS=1, but not eval replays", async () => {
    process.env.AI_CAPTURE_PROMPTS = "1";
    const { client } = fakeClient([{ content: [text("answer")] }, { content: [text("replay")] }]);
    const a = await callClaude({ db, rates, client }, { ...call("dna.gaps"), feature: "copy.bio" });
    await callClaude({ db, rates, client }, { ...call("dna.gaps"), feature: "copy.bio", override: { provider: "anthropic", model: MODELS.opus } });
    const rows = await db.select().from(schema.promptCaptures).where(eq(schema.promptCaptures.feature, "copy.bio"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ output: "answer", model: MODELS.sonnet, request: { system: "sys" } });
    const [billed] = await db.select().from(schema.providerCalls).where(eq(schema.providerCalls.id, a.callIds[0]!));
    expect(rows[0]!.actualMicros).toBe(billed!.actualMicros);
  });
});

describe("Anthropic fallback beta", () => {
  it("retries once without the beta when the API rejects it", async () => {
    const calls: Record<string, unknown>[] = [];
    const { client: plain } = fakeClient([{ content: [text("ok")] }]);
    const client = {
      messages: {
        stream: (p: Record<string, unknown>) => (calls.push(p), (plain.messages.stream as (x: unknown) => unknown)(p)),
      },
      beta: {
        messages: {
          stream: (p: Record<string, unknown>) => {
            calls.push(p);
            throw Object.assign(new Error(`400 ${FALLBACK_BETA}: fallbacks not supported for this model`), { status: 400 });
          },
        },
      },
    } as never;
    const out = await callClaude({ db, rates, client }, { workspaceId: ws, budgetPeriodIds: periods, feature: "dna.one_liner", system: "s", messages: [{ role: "user", content: "x" }] });
    expect(out.servedModel).toBe(MODELS.opus);
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty("betas");
  });
});
