import { describe, expect, it } from "vitest";
import { estimateClaudeMicros, formatUsd, priceClaudeUsage, SEED_RATES, USD } from "./pricing.ts";

const opus = SEED_RATES.find((r) => r.model === "claude-opus-5")!.rates;

describe("priceClaudeUsage", () => {
  it("prices input and output per MTok", () => {
    const c = priceClaudeUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, opus);
    expect(c.totalMicros).toBe(30 * USD); // $5 in + $25 out
  });

  it("splits cache writes by TTL and discounts reads", () => {
    const c = priceClaudeUsage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      },
      opus,
    );
    // read $0.50 + 5m write $6.25 + 1h write $10
    expect(c.totalMicros).toBe(16.75 * USD);
  });

  it("adds $0.01 per web search as a server tool fee", () => {
    const c = priceClaudeUsage({ input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }, opus);
    expect(c).toEqual({ totalMicros: 30_000, serverToolFeesMicros: 30_000 });
  });

  it("halves token cost for batch calls", () => {
    const c = priceClaudeUsage({ input_tokens: 1_000_000, output_tokens: 0 }, opus, { batch: true });
    expect(c.totalMicros).toBe(2.5 * USD);
  });

  it("rounds each line up so tiny calls are never free", () => {
    expect(priceClaudeUsage({ input_tokens: 1, output_tokens: 1 }, opus).totalMicros).toBe(5 + 25);
  });
});

describe("estimateClaudeMicros", () => {
  it("uses chars/3.5 for input and the full max_tokens for output", () => {
    // 3500 chars → 1000 tokens → $0.005; 1000 output → $0.025
    expect(estimateClaudeMicros(3500, 1000, opus)).toBe(30_000);
  });
});

describe("formatUsd", () => {
  it("shows sub-cent amounts with 4 decimals", () => {
    expect(formatUsd(5_000)).toBe("$0.0050");
    expect(formatUsd(7_400_000)).toBe("$7.40");
  });
});
