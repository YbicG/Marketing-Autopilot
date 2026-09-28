import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import type { FetchLike } from "../ai/openrouter.ts";
import { fakeClient, jsonReply } from "../ai/testing.ts";
import { ensurePeriods } from "../cost/ledger.ts";
import { loadRateCards, rateLookup, seedPricingRates } from "../cost/rates.ts";
import { research, ResearchSearchMissing } from "./steps.ts";
import type { FetchText } from "./types.ts";
import { braveSearch, exaSearch, pageText, resolveWebSearch } from "./web-search.ts";

let db: Db;
let close: () => Promise<void>;
let ws: string;
let periods: string[];

beforeAll(async () => {
  process.env.OPENROUTER_API_KEY ??= "test-key";
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  ws = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  periods = await ensurePeriods(db, ws, [{ scope: "global_month", capMicros: 50_000_000 }]);
});
afterAll(() => close());
afterEach(() => {
  delete process.env.AI_MODEL_OVERRIDES;
});

describe("search clients", () => {
  it("Exa posts the query with the key in a header", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const search = exaSearch("exa-key", async (url, init) => {
      seen.push({ url, ...init });
      return { status: 200, text: JSON.stringify({ results: [{ title: "A", url: "https://a.com", text: "  lots   of text " }, { title: "no url" }] }) };
    });
    expect(await search("calendar apps")).toEqual([{ title: "A", url: "https://a.com", snippet: "lots of text" }]);
    expect(seen[0]!.url).toBe("https://api.exa.ai/search");
    expect(seen[0]!.headers["x-api-key"]).toBe("exa-key");
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ query: "calendar apps" });
  });

  it("Brave goes through fetchText with the token header, never in the URL", async () => {
    const urls: string[] = [];
    const fetchText: FetchText = async (url, init) => {
      urls.push(url);
      expect(init?.headers?.["x-subscription-token"]).toBe("brave-key");
      return { url, status: 200, contentType: "application/json", text: JSON.stringify({ web: { results: [{ title: "B", url: "https://b.com", description: "<strong>hi</strong>" }] } }) };
    };
    expect(await braveSearch("brave-key", fetchText)("x y")).toEqual([{ title: "B", url: "https://b.com", snippet: "hi" }]);
    expect(urls[0]).not.toContain("brave-key");
  });

  it("resolves Exa, then Brave, then nothing", async () => {
    const fetchText = (async () => ({})) as unknown as FetchText;
    expect(await resolveWebSearch(db, ws, { fetchText, env: {} })).toBeNull();
    expect(await resolveWebSearch(db, ws, { fetchText, env: { BRAVE_API_KEY: "b" } })).toBeTypeOf("function");
  });

  it("pageText strips markup and caps the length", () => {
    expect(pageText("<html><script>x()</script><style>p{}</style><p>Hello&nbsp;&amp; <b>bye</b></p></html>")).toBe("Hello & bye");
    expect(pageText("a".repeat(50), 10)).toHaveLength(10);
  });
});

describe("research on OpenRouter", () => {
  const ctx = (extra: { fetch?: FetchLike } = {}) => {
    const { client } = fakeClient([jsonReply({ findings: [], competitors: [], pains: [] })]);
    return { ai: { db, rates: rateLookup(new Map()), client, ...extra }, workspaceId: ws, budgetPeriodIds: periods, runId: uuidv7() };
  };
  const sink = { finding: async () => {}, competitor: async () => {}, pain: async () => {} };

  it("needs an Exa or Brave key", async () => {
    process.env.AI_MODEL_OVERRIDES = "ingest.research=openrouter:z-ai/glm-5.3-flash";
    await expect(
      research(ctx(), { productBrief: "p", fetchText: (async () => ({})) as never, sink, webSearch: null }),
    ).rejects.toBeInstanceOf(ResearchSearchMissing);
  });

  it("sends client web_search/web_fetch instead of server tools and runs them", async () => {
    process.env.AI_MODEL_OVERRIDES = "ingest.research=openrouter:z-ai/glm-5.3-flash";
    const bodies: Record<string, unknown>[] = [];
    const call = (id: string, name: string, args: unknown) => ({
      model: "z-ai/glm-5.3-flash",
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
      usage: { cost: 0.0001 },
    });
    const replies = [
      call("c1", "web_search", { query: "syllabus calendar" }),
      call("c2", "web_fetch", { url: "https://a.com/page" }),
      { model: "z-ai/glm-5.3-flash", choices: [{ finish_reason: "stop", message: { content: "done" } }], usage: { cost: 0.0001 } },
    ];
    const fetch: FetchLike = async (_u, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return { ok: true, status: 200, text: async () => JSON.stringify(replies.shift()) };
    };
    const fetched: string[] = [];
    const fetchText: FetchText = async (url) => (fetched.push(url), { url, status: 200, contentType: "text/html", text: "<p>Deadlines are painful</p>" });
    const searched: string[] = [];

    const c = ctx({ fetch });
    c.ai.rates = rateLookup(await loadRateCards(db));
    await research(c, { productBrief: "p", fetchText, sink, webSearch: async (q) => (searched.push(q), [{ title: "A", url: "https://a.com/page", snippet: "s" }]) });

    const names = (bodies[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["web_search", "web_fetch", "record_pain", "hn_search"]));
    expect(searched).toEqual(["syllabus calendar"]);
    expect(fetched).toEqual(["https://a.com/page"]);
    const toolMsgs = (bodies[2]!.messages as { role: string; content: string }[]).filter((m) => m.role === "tool");
    expect(toolMsgs[1]!.content).toContain("Deadlines are painful");
    expect(toolMsgs[1]!.content).toContain("<source_text");
  });
});
