// §5.2 step 4: the evidence bundle. One deterministic markdown document that every synthesis call
// reads, with stable source ids (S1, S2…) that evidence and claims point back to.

export type SourceOrigin = "owned_public" | "owned_internal" | "third_party";

export interface EvidenceArtifact {
  artifactId: string;
  sourceId: string;
  /** website / github / folder_upload / text / research */
  sourceKind: string;
  kind: string;
  title: string | null;
  url: string | null;
  path: string | null;
  text: string;
  visibility: "public_ok" | "internal";
}

export interface EvidenceResearch {
  id: string;
  kind: "finding" | "competitor" | "pain";
  text: string;
  sourceUrl: string | null;
}

export interface EvidenceAsset {
  assetId: string;
  caption: string | null;
  kind: string | null;
  pageUrl: string | null;
  visibleText: string | null;
}

export interface SourceRef {
  sourceId: string | null;
  artifactId: string | null;
  researchId: string | null;
  url: string | null;
  title: string;
  origin: SourceOrigin;
}

export interface EvidenceBundle {
  markdown: string;
  sourceMap: Record<string, SourceRef>;
  /** S-id → the text it stands for, used by the visibility rule. Not stored. */
  texts: Record<string, string>;
}

const KIND_ORDER = ["page", "repo_meta", "readme", "package_json", "doc", "notes", "brand"];
const PER_ARTIFACT_CHARS: Record<string, number> = { page: 12_000, readme: 16_000, doc: 10_000, notes: 12_000 };
const TOTAL_CHARS = 140_000;

function originOf(a: EvidenceArtifact): SourceOrigin {
  return a.visibility === "public_ok" ? "owned_public" : "owned_internal";
}

function label(a: EvidenceArtifact): string {
  return a.title?.trim() || a.url || a.path || a.kind;
}

/** Order is fixed by (visibility, kind, rank-ish url/path) so the same inputs give the same ids. */
export function buildEvidenceBundle(input: {
  productName: string;
  artifacts: EvidenceArtifact[];
  research: EvidenceResearch[];
  assets: EvidenceAsset[];
  answers: { question: string; answer: string }[];
}): EvidenceBundle {
  const artifacts = [...input.artifacts].sort(
    (a, b) =>
      Number(a.visibility === "internal") - Number(b.visibility === "internal") ||
      rankKind(a.kind) - rankKind(b.kind) ||
      (a.url ?? a.path ?? "").localeCompare(b.url ?? b.path ?? "") ||
      a.artifactId.localeCompare(b.artifactId),
  );
  const sourceMap: Record<string, SourceRef> = {};
  const texts: Record<string, string> = {};
  const out: string[] = [
    `# Evidence for ${input.productName}`,
    "",
    "Source ids (S1, S2…) are what evidence, claims and quotes cite. PUBLIC sources are the product's own website or public repo.",
    "INTERNAL sources are the developer's private docs and notes: use them to understand the product, never quote them.",
    "THIRD-PARTY sources are other websites found during research.",
    "",
  ];
  let budget = TOTAL_CHARS;
  let n = 0;

  for (const a of artifacts) {
    if (budget <= 0) break;
    const id = `S${++n}`;
    const cap = Math.min(PER_ARTIFACT_CHARS[a.kind] ?? 6_000, budget);
    const text = a.text.length > cap ? `${a.text.slice(0, cap)}\n[…cut]` : a.text;
    budget -= text.length;
    sourceMap[id] = {
      sourceId: a.sourceId,
      artifactId: a.artifactId,
      researchId: null,
      url: a.url,
      title: label(a),
      origin: originOf(a),
    };
    texts[id] = a.text;
    const tag = a.visibility === "public_ok" ? "PUBLIC" : "INTERNAL";
    out.push(`## ${id} · ${tag} · ${a.kind} · ${label(a)}`);
    if (a.url) out.push(`URL: ${a.url}`);
    else if (a.path) out.push(`File: ${a.path}`);
    out.push("", "<source_text>", text.trim(), "</source_text>", "");
  }

  const research = [...input.research].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  if (research.length) out.push("# Research (third-party)", "");
  for (const r of research) {
    const id = `S${++n}`;
    sourceMap[id] = { sourceId: null, artifactId: null, researchId: r.id, url: r.sourceUrl, title: r.kind, origin: "third_party" };
    texts[id] = r.text;
    out.push(`- ${id} · THIRD-PARTY · ${r.kind}: ${r.text}${r.sourceUrl ? ` (${r.sourceUrl})` : ""}`);
  }

  if (input.assets.length) out.push("", "# Screenshots", "");
  for (const a of [...input.assets].sort((x, y) => x.assetId.localeCompare(y.assetId))) {
    out.push(`- asset ${a.assetId}: ${a.kind ?? "screenshot"} · ${a.caption ?? "no caption"}${a.pageUrl ? ` · ${a.pageUrl}` : ""}`);
  }

  if (input.answers.length) {
    const id = `S${++n}`;
    const text = input.answers.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n");
    sourceMap[id] = { sourceId: null, artifactId: null, researchId: null, url: null, title: "Your answers", origin: "owned_internal" };
    texts[id] = text;
    out.push("", `## ${id} · INTERNAL · answers from the developer`, "", "<source_text>", text, "</source_text>");
  }

  return { markdown: out.join("\n") + "\n", sourceMap, texts };
}

function rankKind(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

// ── visibility rule (§5.2 step 5, M1 done-when) ──

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const STOP = new Set("a an and are as at be by for from has have in is it its of on or that the this to with you your we our can".split(" "));

function contentWords(s: string): string[] {
  return norm(s)
    .split(/[^a-z0-9$%.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Numbers, prices and percentages must appear verbatim in the public text. */
function figures(s: string): string[] {
  return [...norm(s).matchAll(/\$?\d[\d,]*(?:\.\d+)?%?/g)].map((m) => m[0].replace(/,/g, ""));
}

/**
 * Is this statement backed by the given public text? A quote must appear verbatim (whitespace and
 * quotes normalized). Without a quote, every figure must appear and most content words must too.
 */
export function supportedBy(statement: string, quote: string | null, publicText: string): boolean {
  const hay = norm(publicText);
  const hayNoCommas = hay.replace(/(\d),(\d)/g, "$1$2");
  if (quote && quote.trim().length >= 8) return hay.includes(norm(quote));
  const figs = figures(statement);
  if (figs.some((f) => !hayNoCommas.includes(f))) return false;
  const words = contentWords(statement);
  if (words.length === 0) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.7;
}

/**
 * A claim may be public (usable in posts) only if a cited source is the product's own public
 * website/repo and that source's text actually supports it. Internal docs never make a claim public,
 * even when the model mislabels the citation. Competitor comparisons may rest on third-party pages.
 */
export function claimIsPublic(
  claim: { kind: string; text: string; quote: string | null; sourceIds: string[] },
  bundle: Pick<EvidenceBundle, "sourceMap" | "texts">,
): boolean {
  for (const id of claim.sourceIds) {
    const ref = bundle.sourceMap[id];
    const text = bundle.texts[id];
    if (!ref || !text) continue;
    const allowed = ref.origin === "owned_public" || (ref.origin === "third_party" && claim.kind === "comparison");
    if (allowed && supportedBy(claim.text, claim.quote, text)) return true;
  }
  return false;
}
