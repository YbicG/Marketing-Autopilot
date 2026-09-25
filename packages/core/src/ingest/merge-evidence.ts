import {
  DNA_SECTION_IDS,
  type Confidence,
  type DnaSectionId,
  type Evidence,
  type FieldMeta,
  type FieldMetaMap,
  type ProductDna,
  type Unsure,
} from "@mkt/contracts";

export interface SectionResult<T = unknown> {
  values: T;
  evidence: Evidence[];
  unsure: Unsure[];
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** "offer.pricing.tiers[0].price" → "offer.pricing" (metadata is kept per top-level field). */
export function fieldPathOf(path: string): string | null {
  const parts = path.replace(/\[\d+\]/g, "").split(".").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}.${parts[1]}`;
}

/**
 * Fold per-section evidence into per-field metadata (§5.2 step 5). Unknown source ids are dropped,
 * so a hallucinated "S99" never shows up as a source chip. Returns coverage: the share of non-empty
 * fields with at least one real source.
 */
export function mergeEvidence(
  sections: Record<DnaSectionId, SectionResult>,
  knownSourceIds: ReadonlySet<string>,
): { dna: ProductDna; fields: FieldMetaMap; coveragePct: number } {
  const dna = {} as Record<DnaSectionId, unknown>;
  const fields: FieldMetaMap = {};
  let nonEmpty = 0;
  let sourced = 0;

  for (const section of DNA_SECTION_IDS) {
    const res = sections[section];
    dna[section] = res.values;
    const byField = new Map<string, Evidence[]>();
    for (const ev of res.evidence) {
      const p = fieldPathOf(ev.path);
      if (!p || !p.startsWith(`${section}.`)) continue;
      byField.set(p, [...(byField.get(p) ?? []), ev]);
    }
    const unsureByField = new Map<string, string>();
    for (const u of res.unsure) {
      const p = fieldPathOf(u.path);
      if (p && !unsureByField.has(p)) unsureByField.set(p, u.question);
    }

    for (const [key, value] of Object.entries(res.values as Record<string, unknown>)) {
      const path = `${section}.${key}`;
      const evs = byField.get(path) ?? [];
      const sources = [...new Set(evs.flatMap((e) => e.sourceIds).filter((id) => knownSourceIds.has(id)))];
      const best = evs.reduce<Confidence | null>((acc, e) => (acc === null || RANK[e.confidence] > RANK[acc] ? e.confidence : acc), null);
      const meta: FieldMeta = {
        confidence: sources.length ? (best ?? "low") : "low",
        sources,
        quote: evs.find((e) => e.quote && e.sourceIds.some((id) => knownSourceIds.has(id)))?.quote ?? null,
        pinned: false,
        editedBy: "model",
        unsure: unsureByField.get(path) ?? null,
      };
      fields[path] = meta;
      if (!isEmpty(value)) {
        nonEmpty++;
        if (sources.length) sourced++;
      }
    }
  }
  const coveragePct = nonEmpty === 0 ? 0 : Math.round((sourced / nonEmpty) * 100);
  return { dna: dna as ProductDna, fields, coveragePct };
}

/** A regenerate keeps every pinned field exactly as the user left it (value and metadata). */
export function applyPins(
  next: { dna: ProductDna; fields: FieldMetaMap },
  prev: { dna: ProductDna; fields: FieldMetaMap } | null,
): { dna: ProductDna; fields: FieldMetaMap } {
  if (!prev) return next;
  const dna = structuredClone(next.dna) as unknown as Record<string, Record<string, unknown>>;
  const fields = { ...next.fields };
  const prevDna = prev.dna as unknown as Record<string, Record<string, unknown>>;
  for (const [path, meta] of Object.entries(prev.fields)) {
    if (!meta.pinned) continue;
    const [section, key] = path.split(".") as [string, string];
    if (!prevDna[section] || !(key in prevDna[section]!) || !dna[section]) continue;
    dna[section]![key] = structuredClone(prevDna[section]![key]);
    fields[path] = { ...meta };
  }
  return { dna: dna as unknown as ProductDna, fields };
}

/** Fields the plan screen lists first: model-flagged unsure items and anything low-confidence. */
export function unsureItems(fields: FieldMetaMap): { path: string; question: string }[] {
  return Object.entries(fields)
    .filter(([, m]) => !m.pinned && m.editedBy !== "user" && (m.unsure || m.confidence === "low"))
    .map(([path, m]) => ({ path, question: m.unsure ?? "We couldn't find a source for this. Is it right?" }));
}

/** Set one field from the UI: the value is the user's now, and it's pinned so a regenerate keeps it. */
export function editField(
  dna: ProductDna,
  fields: FieldMetaMap,
  path: string,
  value: unknown,
): { dna: ProductDna; fields: FieldMetaMap } {
  const [section, key, ...rest] = path.split(".");
  if (!section || !key || rest.length || !(DNA_SECTION_IDS as string[]).includes(section)) {
    throw new Error(`not an editable field: ${path}`);
  }
  const next = structuredClone(dna) as unknown as Record<string, Record<string, unknown>>;
  if (!(key in next[section]!)) throw new Error(`not an editable field: ${path}`);
  next[section]![key] = value;
  const prev = fields[path];
  return {
    dna: next as unknown as ProductDna,
    fields: {
      ...fields,
      [path]: { confidence: "high", sources: prev?.sources ?? [], quote: prev?.quote ?? null, pinned: true, editedBy: "user", unsure: null },
    },
  };
}
