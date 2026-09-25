import { z } from "zod";

/** Keywords the structured-output API rejects (§5.0). The full zod schema re-validates the result. */
const UNSUPPORTED = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
]);

const SUPPORTED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function clean(node: Json): Json {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== "object") return node;
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED.has(k)) continue;
    if (k === "format" && typeof v === "string" && !SUPPORTED_FORMATS.has(v)) continue;
    // Property names are data, not keywords: clean their schemas but keep every key.
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, clean(s)]));
      continue;
    }
    out[k] = clean(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** A zod schema as a JSON Schema the API accepts. */
export function claudeFormat(schema: z.ZodType): { type: "json_schema"; schema: Record<string, Json> } {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) as Json;
  return { type: "json_schema", schema: clean(json) as Record<string, Json> };
}

export const BANNED_SCHEMA_KEYWORDS = [...UNSUPPORTED];
