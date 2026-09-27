import { describe, expect, it } from "vitest";
import { SEED_RATES, type RateCard } from "../../cost/pricing.ts";
import { estimateLandingAuditMicros } from "./estimate.ts";
import { LANDING_JUDGE_CAP_MICROS } from "./audit-io.ts";

const rates = (model: string): RateCard => SEED_RATES.find((r) => r.model === model)!.rates;

describe("estimateLandingAuditMicros", () => {
  it("prices one phone-screenshot look, under the judge's run cap", () => {
    const micros = estimateLandingAuditMicros(rates);
    expect(micros).toBeGreaterThan(10_000);
    expect(micros).toBeLessThanOrEqual(LANDING_JUDGE_CAP_MICROS);
  });
});
