import type Anthropic from "@anthropic-ai/sdk";
import { secret } from "../config/index.ts";
import type { Effort, FeatureConfig } from "./features.ts";

/**
 * OpenRouter transport. The rest of the AI layer speaks Anthropic Messages; this translates one
 * request to OpenRouter's chat completions and the reply back into an Anthropic-shaped message, so
 * callClaude, the tool loop, structured output and the budget code are the same for both providers.
 *
 * Every request asks for zero data retention, no provider data collection, and only providers that
 * support every parameter sent (tools, response_format). Server tools (web search/fetch) are
 * Anthropic-only and are left out here; the research step swaps in client tools instead.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class OpenRouterError extends Error {
  readonly code = "openrouter_error";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`OpenRouter ${status}: ${message.slice(0, 500)}`);
    this.name = "OpenRouterError";
  }
}

interface OrToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type OrPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type OrMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OrPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OrToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OrRequestInput {
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.ToolUnion[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

/** OpenRouter's reasoning efforts stop at high. */
function orEffort(e: Effort): "low" | "medium" | "high" {
  return e === "low" || e === "medium" ? e : "high";
}

function imagePart(block: Anthropic.ImageBlockParam): OrPart | null {
  const src = block.source as { type: string; media_type?: string; data?: string; url?: string };
  if (src.type === "base64" && src.data) return { type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` } };
  if (src.type === "url" && src.url) return { type: "image_url", image_url: { url: src.url } };
  return null;
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const c = block.content;
  const text =
    typeof c === "string"
      ? c
      : (c ?? [])
          .map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[image omitted]" : ""))
          .filter(Boolean)
          .join("\n");
  return block.is_error ? `ERROR: ${text}` : text;
}

export function toOpenRouterMessages(system: string, messages: Anthropic.MessageParam[]): OrMessage[] {
  const out: OrMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = m.content.flatMap((b): OrToolCall[] =>
        b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results become tool messages (they must directly follow the assistant's calls).
    const parts: OrPart[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b) });
      else if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") {
        const p = imagePart(b);
        if (p) parts.push(p);
      }
    }
    if (parts.length) out.push({ role: "user", content: parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts });
  }
  return out;
}

export function toOpenRouterTools(tools: Anthropic.ToolUnion[] | undefined) {
  return (tools ?? []).flatMap((t) => {
    const c = t as { name: string; description?: string; input_schema?: Record<string, unknown> };
    // Server tools (web_search_*, web_fetch_*) carry no input_schema and don't exist on OpenRouter.
    if (!c.input_schema) return [];
    return [{ type: "function" as const, function: { name: c.name, description: c.description ?? "", parameters: c.input_schema } }];
  });
}

export function openRouterBody(cfg: FeatureConfig, input: OrRequestInput, maxTokens: number): Record<string, unknown> {
  const tools = toOpenRouterTools(input.tools);
  return {
    model: cfg.model,
    messages: toOpenRouterMessages(input.system, input.messages),
    max_tokens: maxTokens,
    reasoning: { effort: orEffort(cfg.effort) },
    ...(tools.length ? { tools } : {}),
    ...(input.outputFormat
      ? { response_format: { type: "json_schema", json_schema: { name: "output", strict: false, schema: input.outputFormat.schema } } }
      : {}),
    usage: { include: true },
    provider: { data_collection: "deny", zdr: true, require_parameters: true },
  };
}

interface OrResponse {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null; tool_calls?: OrToolCall[] | null };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null; cost?: number | null };
  error?: { code?: number | string; message?: string };
}

export interface OpenRouterReply {
  message: Anthropic.Message;
  /** What OpenRouter billed, in micros; null when the response didn't say. */
  costMicros: number | null;
  usage: Record<string, unknown>;
}

function stopReason(finish: string | null | undefined, refused: boolean): Anthropic.Message["stop_reason"] {
  if (refused || finish === "content_filter") return "refusal";
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls") return "tool_use";
  return "end_turn";
}

export function fromOpenRouterResponse(json: OrResponse, requestedModel: string): OpenRouterReply {
  const choice = json.choices?.[0];
  if (!choice?.message) throw new OpenRouterError(502, json.error?.message ?? "no choices in the response");
  const msg = choice.message;
  const content: Anthropic.ContentBlock[] = [];
  if (msg.content) content.push({ type: "text", text: msg.content, citations: null } as Anthropic.TextBlock);
  for (const call of msg.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      // The tool loop validates every input; this fails validation and goes back as an error result.
      input = { INVALID_JSON: call.function.arguments.slice(0, 2_000) };
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input } as Anthropic.ToolUseBlock);
  }
  const hasCalls = (msg.tool_calls?.length ?? 0) > 0;
  const u = json.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const message = {
    id: json.id ?? "",
    type: "message",
    role: "assistant",
    model: json.model ?? requestedModel,
    content,
    // Some providers finish with "stop" while returning tool calls; the calls win.
    stop_reason: hasCalls && choice.finish_reason !== "length" ? "tool_use" : stopReason(choice.finish_reason, !!msg.refusal),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      server_tool_use: null,
    },
  } as unknown as Anthropic.Message;
  const costMicros = typeof u.cost === "number" && Number.isFinite(u.cost) ? Math.ceil(u.cost * 1_000_000) : null;
  return { message, costMicros, usage: u as Record<string, unknown> };
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** One OpenRouter completion. 429/5xx get two retries with backoff, like the Anthropic SDK's maxRetries: 2. */
export async function openRouterMessage(
  cfg: FeatureConfig,
  input: OrRequestInput,
  maxTokens: number,
  opts: { fetch?: FetchLike; apiKey?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<OpenRouterReply> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const body = JSON.stringify(openRouterBody(cfg, input, maxTokens));
  const headers = {
    authorization: `Bearer ${opts.apiKey ?? secret("OPENROUTER_API_KEY")}`,
    "content-type": "application/json",
    "x-title": "Marketing Autopilot",
  };
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(OPENROUTER_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(600_000) });
    const text = await res.text();
    let json: OrResponse = {};
    try {
      json = JSON.parse(text) as OrResponse;
    } catch {
      // handled below
    }
    if (res.ok && !json.error) return fromOpenRouterResponse(json, cfg.model);
    const status = res.ok ? Number(json.error?.code) || 502 : res.status;
    if (RETRYABLE.has(status) && attempt < 2) {
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    throw new OpenRouterError(status, json.error?.message ?? text);
  }
}
