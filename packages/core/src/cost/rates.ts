import { desc, sql } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { SEED_RATES, type RateCard, type RateUnit } from "./pricing.ts";

const { pricingRates } = schema;

/**
 * Write the seed rate card at its effective date. Seed-dated rows follow the code; a correction made
 * by hand goes in as a row with a later effectiveFrom, which this never touches.
 */
export async function seedPricingRates(db: Db, effectiveFrom = new Date("2026-01-01T00:00:00Z")): Promise<void> {
  const rows = SEED_RATES.flatMap((s) =>
    Object.entries(s.rates).map(([unit, micros]) => ({
      id: uuidv7(),
      provider: s.provider,
      model: s.model,
      unit: unit as RateUnit,
      microsPerUnit: micros,
      verified: s.verified,
      source: s.source,
      effectiveFrom,
    })),
  );
  // Upsert, so a corrected seed row reaches an existing database on the next worker boot.
  await db
    .insert(pricingRates)
    .values(rows)
    .onConflictDoUpdate({
      target: [pricingRates.provider, pricingRates.model, pricingRates.unit, pricingRates.effectiveFrom],
      set: { microsPerUnit: sql`excluded.micros_per_unit`, verified: sql`excluded.verified`, source: sql`excluded.source` },
    });
}

/** Current rate card per model: the newest effective row for each (model, unit). */
export async function loadRateCards(db: Db, now = new Date()): Promise<Map<string, RateCard>> {
  const rows = await db.select().from(pricingRates).orderBy(desc(pricingRates.effectiveFrom));
  const cards = new Map<string, RateCard>();
  for (const r of rows) {
    if (r.effectiveFrom > now) continue;
    const card = cards.get(r.model) ?? {};
    card[r.unit] ??= r.microsPerUnit;
    cards.set(r.model, card);
  }
  return cards;
}

export function rateLookup(cards: Map<string, RateCard>): (model: string) => RateCard {
  return (model) => {
    const card = cards.get(model);
    if (!card) throw new Error(`No pricing_rates for model ${model}`);
    return card;
  };
}
