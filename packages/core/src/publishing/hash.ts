import { createHash } from "node:crypto";

/** JSON with sorted keys and no undefined members, so equal content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)));
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  return v;
}

export interface ApprovalHashInput {
  /** Everything that gets posted as words: caption, title, thread parts (see publishText). */
  text: string;
  /** Final media in posting order. Order matters: a reordered carousel is a different post. */
  mediaSha256s: string[];
  platformOptions: Record<string, unknown>;
}

/** approvals.content_hash (§4.2): text + final media sha256s + options. Re-checked at publish.prepare. */
export function approvalHash(input: ApprovalHashInput): string {
  const body = canonicalJson({ v: 1, text: input.text, media: input.mediaSha256s, options: input.platformOptions });
  return createHash("sha256").update(body).digest("hex");
}
