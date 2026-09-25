import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { Db } from "@mkt/db";
import { estimateClaudeMicros } from "../cost/pricing.ts";
import { BilledFailure, runPaidCall } from "../cost/run-paid-call.ts";
import { anthropic } from "./client.ts";
import { feature as featureConfig, type FeatureId } from "./features.ts";
import { ClaudeTruncated, assertUsableStop } from "./stop-reasons.ts";
import { claudeFormat } from "./structured.ts";
import { withWatchdog } from "./stream-watchdog.ts";
import { priceMessage, type MessageLike, type RateLookup } from "./usage.ts";

/** The only beta the app sends in M0/M1 (D14): Opus server-side refusal fallbacks, "default" form. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface ClaudeCall {
  workspaceId: string;
  budgetPeriodIds: string[];
  feature: FeatureId;
  system: string;
  messages: Anthropic.MessageParam[];
  runId?: string;
  /** Structured output from `claudeFormat()`. Never combined with web search or fetch (§5.0). */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** Server and client tools. tool_choice is never forced (D22). */
  tools?: Anthropic.ToolUnion[];
  /** Upper bound on web searches this call may run, for the estimate ($0.01 each). */
  maxSearches?: number;
}

/** Kept for the M0 call sites. */
export type ClaudeTextCall = ClaudeCall;

export interface ClaudeCallResult {
  message: Anthropic.Message;
  servedModel: string;
  callIds: string[];
}

export interface ClaudeTextResult {
  text: string;
  servedModel: string;
  callIds: string[];
}

export interface ClaudeDeps {
  db: Db;
  rates: RateLookup;
  client?: Anthropic;
}

/**
 * One streamed Claude call, priced through runPaidCall (reserve → call → settle by served model).
 * `max_tokens` gets one retry at double the limit, as its own paid call. A refusal is billed and thrown.
 * `tool_use` and `pause_turn` come back to the caller (see tool-loop.ts).
 */
export async function callClaude(deps: ClaudeDeps, input: ClaudeCall): Promise<ClaudeCallResult> {
  const cfg = featureConfig(input.feature);
  const callIds: string[] = [];
  let maxTokens = cfg.maxTokens;

  for (let attempt = 0; ; attempt++) {
    try {
      const message = await runPaidCall(
        deps.db,
        {
          workspaceId: input.workspaceId,
          budgetPeriodIds: input.budgetPeriodIds,
          estMicros: estimateClaudeMicros(inputChars(input), maxTokens, deps.rates(cfg.model), input.maxSearches ?? 0),
          feature: input.feature,
          provider: "anthropic",
          requestedModel: cfg.model,
          runId: input.runId,
        },
        async (callId) => {
          callIds.push(callId);
          const msg = await stream(deps.client ?? anthropic(), cfg, input, maxTokens);
          const priced = priceMessage(msg as unknown as MessageLike, deps.rates);
          const billed = {
            ...priced,
            usage: msg.usage as unknown as Record<string, unknown>,
            providerRequestId: msg.id,
          };
          try {
            assertUsableStop(msg, maxTokens);
          } catch (err) {
            throw new BilledFailure(billed, err);
          }
          return { result: msg, ...billed };
        },
      );
      return { message, servedModel: message.model, callIds };
    } catch (err) {
      if (err instanceof ClaudeTruncated && attempt === 0) {
        maxTokens *= 2;
        continue;
      }
      throw err;
    }
  }
}

export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export async function callClaudeText(deps: ClaudeDeps, input: ClaudeCall): Promise<ClaudeTextResult> {
  const { message, servedModel, callIds } = await callClaude(deps, input);
  return { text: textOf(message), servedModel, callIds };
}

export class StructuredOutputInvalid extends Error {
  readonly code = "invalid_output";
  constructor(readonly issues: string) {
    super(`Claude's answer didn't match the expected shape: ${issues.slice(0, 300)}`);
    this.name = "StructuredOutputInvalid";
  }
}

/**
 * Structured output (§5.0): the model sees the claudeFormat() of `schema`, the full zod schema
 * re-validates, and one repair call with the zod issues follows a failure. Then it's "Needs you".
 */
export async function callClaudeJson<S extends z.ZodType>(
  deps: ClaudeDeps,
  input: Omit<ClaudeCall, "outputFormat" | "tools"> & { schema: S },
): Promise<{ value: z.infer<S>; servedModel: string; callIds: string[] }> {
  const { schema, ...call } = input;
  const outputFormat = claudeFormat(schema);
  const first = await callClaudeText(deps, { ...call, outputFormat });
  const parsed = parseJson(schema, first.text);
  if (parsed.ok) return { value: parsed.value, servedModel: first.servedModel, callIds: first.callIds };

  const repair = await callClaudeText(deps, {
    ...call,
    outputFormat,
    messages: [
      ...call.messages,
      { role: "assistant", content: first.text || "{}" },
      {
        role: "user",
        content: `That JSON failed validation:\n${parsed.issues}\nReturn the corrected JSON only.`,
      },
    ],
  });
  const again = parseJson(schema, repair.text);
  if (!again.ok) throw new StructuredOutputInvalid(again.issues);
  return { value: again.value, servedModel: repair.servedModel, callIds: [...first.callIds, ...repair.callIds] };
}

function parseJson<S extends z.ZodType>(schema: S, text: string): { ok: true; value: z.infer<S> } | { ok: false; issues: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
  };
}

async function stream(client: Anthropic, cfg: ReturnType<typeof featureConfig>, input: ClaudeCall, maxTokens: number) {
  const params = {
    model: cfg.model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" as const },
    output_config: input.outputFormat ? { effort: cfg.effort, format: input.outputFormat } : { effort: cfg.effort },
    system: input.system,
    messages: input.messages,
    ...(input.tools?.length ? { tools: input.tools } : {}),
  };
  if (cfg.fallbacks) {
    // beta.ts in the plan: the only place that touches client.beta.messages.
    const s = client.beta.messages.stream({
      ...(params as unknown as Anthropic.Beta.MessageCreateParamsStreaming),
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    } as Anthropic.Beta.MessageCreateParamsStreaming);
    return (await withWatchdog(s)) as unknown as Anthropic.Message;
  }
  return withWatchdog(client.messages.stream(params as Anthropic.MessageStreamParams));
}

/** Roughly 1,600 tokens per image, however many base64 characters it has. */
const IMAGE_CHARS = 1_600 * 3.5;

function inputChars(input: ClaudeCall): number {
  let n = input.system.length + (input.tools ? JSON.stringify(input.tools).length : 0);
  for (const m of input.messages) {
    if (typeof m.content === "string") {
      n += m.content.length;
      continue;
    }
    for (const block of m.content) {
      if (block.type === "image") n += IMAGE_CHARS;
      else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const c of block.content) n += c.type === "image" ? IMAGE_CHARS : JSON.stringify(c).length;
      } else n += JSON.stringify(block).length;
    }
  }
  return n;
}
