import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@mkt/db";
import { estimateClaudeMicros } from "../cost/pricing.ts";
import { BilledFailure, runPaidCall } from "../cost/run-paid-call.ts";
import { anthropic } from "./client.ts";
import { feature as featureConfig, type FeatureId } from "./features.ts";
import { ClaudeTruncated, assertUsableStop } from "./stop-reasons.ts";
import { withWatchdog } from "./stream-watchdog.ts";
import { priceMessage, type MessageLike, type RateLookup } from "./usage.ts";

/** The only beta the app sends in M0 (D14): Opus server-side refusal fallbacks, "default" form. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface ClaudeTextCall {
  workspaceId: string;
  budgetPeriodIds: string[];
  feature: FeatureId;
  system: string;
  messages: Anthropic.MessageParam[];
  runId?: string;
  /** Structured output from `claudeFormat()`. Never combined with web search or fetch (§5.0). */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

export interface ClaudeTextResult {
  text: string;
  servedModel: string;
  callIds: string[];
}

interface Deps {
  db: Db;
  rates: RateLookup;
  client?: Anthropic;
}

/**
 * A streamed text call, priced through runPaidCall (reserve → call → settle by served model).
 * `max_tokens` gets one retry at double the limit, as its own paid call. A refusal is billed and thrown.
 */
export async function callClaudeText(deps: Deps, input: ClaudeTextCall): Promise<ClaudeTextResult> {
  const cfg = featureConfig(input.feature);
  const callIds: string[] = [];
  let maxTokens = cfg.maxTokens;

  for (let attempt = 0; ; attempt++) {
    try {
      const msg = await runPaidCall(
        deps.db,
        {
          workspaceId: input.workspaceId,
          budgetPeriodIds: input.budgetPeriodIds,
          estMicros: estimateClaudeMicros(inputChars(input), maxTokens, deps.rates(cfg.model)),
          feature: input.feature,
          provider: "anthropic",
          requestedModel: cfg.model,
          runId: input.runId,
        },
        async (callId) => {
          callIds.push(callId);
          const message = await stream(deps.client ?? anthropic(), cfg, input, maxTokens);
          const priced = priceMessage(message as unknown as MessageLike, deps.rates);
          const billed = {
            ...priced,
            usage: message.usage as unknown as Record<string, unknown>,
            providerRequestId: message.id,
          };
          try {
            assertUsableStop(message, maxTokens);
          } catch (err) {
            throw new BilledFailure(billed, err);
          }
          return { result: message, ...billed };
        },
      );
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, servedModel: msg.model, callIds };
    } catch (err) {
      if (err instanceof ClaudeTruncated && attempt === 0) {
        maxTokens *= 2;
        continue;
      }
      throw err;
    }
  }
}

async function stream(client: Anthropic, cfg: ReturnType<typeof featureConfig>, input: ClaudeTextCall, maxTokens: number) {
  const params = {
    model: cfg.model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" as const },
    output_config: input.outputFormat ? { effort: cfg.effort, format: input.outputFormat } : { effort: cfg.effort },
    system: input.system,
    messages: input.messages,
  };
  if (cfg.fallbacks) {
    // beta.ts in the plan: the only place that touches client.beta.messages.
    const s = client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
    return (await withWatchdog(s)) as unknown as Anthropic.Message;
  }
  return withWatchdog(client.messages.stream(params));
}

function inputChars(input: ClaudeTextCall): number {
  let n = input.system.length;
  for (const m of input.messages) {
    n += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  return n;
}
