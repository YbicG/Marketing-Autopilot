import { priceClaudeUsage, type ClaudeUsage, type RateCard } from "../cost/pricing.ts";

interface Iteration extends ClaudeUsage {
  type: string;
  model?: string | null;
}

export interface MessageLike {
  model: string;
  usage: ClaudeUsage & { iterations?: Iteration[] | null };
}

export interface PricedMessage {
  actualMicros: number;
  serverToolFeesMicros: number;
  servedModel: string;
}

export type RateLookup = (model: string) => RateCard;

/**
 * D14: price by the model that actually served. With server-side fallbacks, `usage.iterations`
 * is the per-attempt source of truth and each attempt bills at its own model's rates.
 * An attempt that declined before producing output is reported but not billed.
 */
export function priceMessage(msg: MessageLike, rates: RateLookup, opts: { batch?: boolean } = {}): PricedMessage {
  const its = (msg.usage.iterations ?? []).filter((i) => i.type === "message" || i.type === "fallback_message");
  const hadFallback = its.some((i) => i.type === "fallback_message");

  let tokenMicros = 0;
  if (its.length > 0) {
    its.forEach((it, idx) => {
      const declinedBeforeOutput = hadFallback && idx < its.length - 1 && it.output_tokens === 0;
      if (declinedBeforeOutput) return;
      const model = it.model ?? msg.model;
      tokenMicros += priceClaudeUsage({ ...it, server_tool_use: null }, rates(model), opts).totalMicros;
    });
  } else {
    tokenMicros = priceClaudeUsage({ ...msg.usage, server_tool_use: null }, rates(msg.model), opts).totalMicros;
  }

  const fees = priceClaudeUsage(
    { input_tokens: 0, output_tokens: 0, server_tool_use: msg.usage.server_tool_use },
    rates(msg.model),
  ).serverToolFeesMicros;

  return { actualMicros: tokenMicros + fees, serverToolFeesMicros: fees, servedModel: msg.model };
}
