import { createHash } from "node:crypto";

/** JSON with sorted object keys, so equal specs hash equally whatever order the model wrote them in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** renders and video_specs are keyed by this (§7.1 step 2: renders dedupe by spec_hash). */
export function specHash(spec: unknown): string {
  return hashOf(spec);
}

/**
 * tts_segments key part: whitespace-normalized text. Case and punctuation are kept on purpose:
 * they change how the line is spoken.
 */
export function ttsTextHash(text: string): string {
  return createHash("sha256").update(normalizeLine(text)).digest("hex");
}

export function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
