/**
 * M0 spike: confirm the model ids, structured output, Opus server-side fallbacks, web search
 * and the seed rate card against live API responses. Run once in the worker container:
 *   pnpm --filter @mkt/worker spike
 * Every call uses effort "low" and max_tokens <= 512, so the whole run costs a few cents.
 */
import { z } from "zod";
import { anthropic, BANNED_SCHEMA_KEYWORDS, claudeFormat, FALLBACK_BETA, MODELS } from "@mkt/core/ai";
import { formatUsd, priceClaudeUsage, SEED_RATES, type ClaudeUsage } from "@mkt/core/cost";

const client = anthropic();

interface Row {
  step: string;
  requested: string;
  served: string;
  ms: number;
  usage: ClaudeUsage;
}
const rows: Row[] = [];
let failures = 0;

function fail(msg: string): void {
  failures++;
  console.error(`FAIL  ${msg}`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}

function hasBannedKeyword(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = hasBannedKeyword(n);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  for (const [k, v] of Object.entries(node)) {
    if (k === "properties" && v && typeof v === "object") {
      // Property names are data; only their schemas matter.
      for (const s of Object.values(v)) {
        const hit = hasBannedKeyword(s);
        if (hit) return hit;
      }
      continue;
    }
    if (BANNED_SCHEMA_KEYWORDS.includes(k)) return k;
    const hit = hasBannedKeyword(v);
    if (hit) return hit;
  }
  return null;
}

// (a) Both model ids exist.
async function listModels(): Promise<void> {
  const ids: string[] = [];
  for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
  for (const id of Object.values(MODELS)) {
    if (ids.includes(id)) console.log(`ok    model ${id} is listed`);
    else fail(`model ${id} not in models.list() (${ids.length} models: ${ids.join(", ")})`);
  }
}

// (b) Structured output on Sonnet with a cleaned schema.
async function structured(): Promise<void> {
  const Schema = z.object({
    headline: z.string().min(3).max(80),
    score: z.number().int().min(1).max(10),
    tags: z.array(z.string()).max(3),
  });
  const format = claudeFormat(Schema);
  const banned = hasBannedKeyword(format.schema);
  if (banned) fail(`claudeFormat() left the banned keyword "${banned}" in the schema`);
  else console.log("ok    claudeFormat() schema has no banned keywords");

  const { value: msg, ms } = await timed(() =>
    client.messages.create({
      model: MODELS.sonnet,
      max_tokens: 256,
      output_config: { effort: "low", format },
      messages: [{ role: "user", content: "Rate the phrase 'fresh bread daily' as a bakery headline." }],
    }),
  );
  rows.push({ step: "structured", requested: MODELS.sonnet, served: msg.model, ms, usage: msg.usage });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    const parsed = Schema.safeParse(JSON.parse(text));
    if (parsed.success) console.log(`ok    structured output parsed: ${text}`);
    else fail(`structured output failed zod: ${parsed.error.message}`);
  } catch {
    fail(`structured output was not JSON (stop_reason ${msg.stop_reason}): ${text.slice(0, 200)}`);
  }
}

// (c) Opus through the beta endpoint with server-side fallbacks.
async function fallbacks(): Promise<void> {
  const { value: msg, ms } = await timed(() =>
    client.beta.messages.create({
      model: MODELS.opus,
      max_tokens: 128,
      output_config: { effort: "low" },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    }),
  );
  rows.push({ step: "opus+fallbacks", requested: MODELS.opus, served: msg.model, ms, usage: msg.usage as ClaudeUsage });
  console.log(`ok    opus beta call served by ${msg.model} (stop_reason ${msg.stop_reason})`);
  console.log(`      usage: ${JSON.stringify(msg.usage)}`);
}

// (d) Sonnet with one web search.
async function webSearch(): Promise<void> {
  const { value: msg, ms } = await timed(() =>
    client.messages.create({
      model: MODELS.sonnet,
      max_tokens: 512,
      output_config: { effort: "low" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
      messages: [{ role: "user", content: "Search once: what is the current Anthropic API pricing page URL? One line." }],
    }),
  );
  rows.push({ step: "web_search", requested: MODELS.sonnet, served: msg.model, ms, usage: msg.usage });
  console.log(`ok    web search server_tool_use: ${JSON.stringify(msg.usage.server_tool_use)}`);
  if (!msg.usage.server_tool_use?.web_search_requests) fail("web search call reported no web_search_requests");
}

// (e) Timings, usage and cost at the seed rates.
function report(): void {
  console.log("\nSeed rate card (packages/core/src/cost/pricing.ts), $ per MTok:");
  for (const s of SEED_RATES) {
    const r = s.rates;
    const usd = (m?: number) => (m === undefined ? "-" : (m / 1_000_000).toFixed(2));
    console.log(
      `  ${s.model.padEnd(18)} in ${usd(r.input_mtok)}  out ${usd(r.output_mtok)}  cache read ${usd(r.cache_read_mtok)}` +
        `  search $${((r.web_search_request ?? 0) / 1_000_000).toFixed(3)} each  verified=${s.verified}`,
    );
  }

  console.log("\nCalls:");
  const head = ["step", "requested", "served", "ms", "in", "out", "cache r/w", "searches", "cost @ seed"];
  const table = rows.map((r) => {
    const card = SEED_RATES.find((s) => s.model === r.served)?.rates;
    const cost = card ? formatUsd(priceClaudeUsage(r.usage, card).totalMicros) : "no rate row";
    return [
      r.step,
      r.requested,
      r.served,
      String(r.ms),
      String(r.usage.input_tokens),
      String(r.usage.output_tokens),
      `${r.usage.cache_read_input_tokens ?? 0}/${r.usage.cache_creation_input_tokens ?? 0}`,
      String(r.usage.server_tool_use?.web_search_requests ?? 0),
      cost,
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(head));
  for (const row of table) console.log(line(row));
  console.log("\nCompare the cost column with the Anthropic console's usage page for these request ids before");
  console.log("flipping `verified` on a seed row.");
}

async function main(): Promise<void> {
  for (const [name, step] of [
    ["models.list", listModels],
    ["structured", structured],
    ["opus+fallbacks", fallbacks],
    ["web_search", webSearch],
  ] as const) {
    try {
      await step();
    } catch (err) {
      fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  report();
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll spike checks passed.");
  process.exitCode = failures ? 1 : 0;
}

await main();
