/** Micro-dollars: $1 = 1_000_000. All money in the app is integer micros (D5). */
export const USD = 1_000_000;

export type RateUnit =
  | "input_mtok"
  | "output_mtok"
  | "cache_read_mtok"
  | "cache_write_5m_mtok"
  | "cache_write_1h_mtok"
  | "web_search_request";

export type RateCard = Partial<Record<RateUnit, number>>;

export interface SeedRate {
  provider: string;
  model: string;
  rates: RateCard;
  verified: boolean;
  source: string;
}

const perMTok = (usd: number) => Math.round(usd * USD);

function anthropic(model: string, inUsd: number, outUsd: number, verified: boolean, source: string, cacheReadX = 0.1, provider = "anthropic"): SeedRate {
  return {
    provider,
    model,
    verified,
    source,
    rates: {
      input_mtok: perMTok(inUsd),
      output_mtok: perMTok(outUsd),
      cache_read_mtok: perMTok(inUsd * cacheReadX),
      cache_write_5m_mtok: perMTok(inUsd * 1.25),
      cache_write_1h_mtok: perMTok(inUsd * 2),
      web_search_request: 10_000, // $10 per 1,000 searches
    },
  };
}

/**
 * Seed rate card. The M0 spike confirms every row against the Anthropic pricing page and
 * flips `verified`; unverified rows still price calls, but the Spending page flags them.
 */
export const SEED_RATES: SeedRate[] = [
  anthropic("claude-opus-5", 5, 25, true, "claude-api skill models.md: Opus 4.8 pricing, $5/$25 per MTok"),
  anthropic("claude-opus-5-5", 4, 20, true, "platform.claude.com pricing, 2026-09-28: $4/$20 per MTok, cache hits 0.05x", 0.05),
  anthropic("claude-sonnet-5", 2, 10, true, "platform.claude.com pricing, 2026-09-28: $2/$10 per MTok is the standard price (the $3/$15 increase was cancelled)"),
  // OpenRouter: only for the reservation estimate. Calls settle at the cost OpenRouter reports (usage.cost).
  openrouter("z-ai/glm-5.3-flash", 0.15, 0.5),
  openrouter("deepseek/deepseek-v4.1-flash", 0.3, 1.2),
  openrouter("openai/gpt-6-luna", 0.1, 0.5),
  openrouter("openai/gpt-6-luna-pro", 0.1, 0.5),
  openrouter("google/gemini-3.8-flash", 0.75, 3.75),
];

function openrouter(model: string, inUsd: number, outUsd: number): SeedRate {
  return anthropic(model, inUsd, outUsd, true, "openrouter.ai/api/v1/models, 2026-09-28", 0.1, "openrouter");
}

/**
 * An OpenRouter model with no rate row is estimated at this card, well above every cheap model,
 * so a reservation is never too small. What's billed is still OpenRouter's reported cost.
 */
export const OPENROUTER_FALLBACK_CARD: RateCard = {
  input_mtok: perMTok(2),
  output_mtok: perMTok(10),
  cache_read_mtok: perMTok(0.2),
  cache_write_5m_mtok: perMTok(2.5),
  cache_write_1h_mtok: perMTok(4),
  web_search_request: 10_000,
};

/** The subset of Anthropic `Usage` we price. Field names match the API response. */
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  server_tool_use?: { web_search_requests?: number } | null;
}

export interface CostBreakdown {
  totalMicros: number;
  serverToolFeesMicros: number;
}

/** Price a Claude response. Thinking tokens are already inside output_tokens. Each line rounds up. */
export function priceClaudeUsage(u: ClaudeUsage, card: RateCard, opts: { batch?: boolean } = {}): CostBreakdown {
  const rate = (unit: RateUnit) => {
    const r = card[unit];
    if (r === undefined) throw new Error(`No rate for ${unit}`);
    return r;
  };
  const tok = (n: number, unit: RateUnit) => (n > 0 ? Math.ceil((n * rate(unit)) / 1_000_000) : 0);

  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m =
    u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - write1h);

  let tokens =
    tok(u.input_tokens, "input_mtok") +
    tok(u.output_tokens, "output_mtok") +
    tok(u.cache_read_input_tokens ?? 0, "cache_read_mtok") +
    tok(write5m, "cache_write_5m_mtok") +
    tok(write1h, "cache_write_1h_mtok");
  if (opts.batch) tokens = Math.ceil(tokens / 2);

  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const serverToolFeesMicros = searches > 0 ? searches * rate("web_search_request") : 0;
  return { totalMicros: tokens + serverToolFeesMicros, serverToolFeesMicros };
}

/** Pre-call estimate (§7.1): ceil(chars / 3.5) input tokens plus the full max_tokens of output. */
export function estimateClaudeMicros(inputChars: number, maxTokens: number, card: RateCard, maxSearches = 0): number {
  return priceClaudeUsage(
    {
      input_tokens: Math.ceil(inputChars / 3.5),
      output_tokens: maxTokens,
      server_tool_use: { web_search_requests: maxSearches },
    },
    card,
  ).totalMicros;
}

export function formatUsd(micros: number): string {
  const usd = micros / USD;
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
