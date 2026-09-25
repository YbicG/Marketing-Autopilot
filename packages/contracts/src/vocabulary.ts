// ── Jargon hiding (§2.6): each marketing concept has one plain UI phrase. ──

export interface VocabEntry {
  concept: string;
  /** Whole-word matches, case-insensitive. Plurals are listed explicitly. */
  terms: readonly string[];
  phrase: string;
  /** Also wrong in a public post (not just in our UI). SEO and ASO can be fair game in a dev-tool post. */
  inPosts: boolean;
}

export const VOCABULARY: readonly VocabEntry[] = [
  { concept: "ICP", terms: ["ICP", "ICPs", "ideal customer profile"], phrase: "who it's for", inPosts: true },
  { concept: "JTBD", terms: ["JTBD", "jobs to be done", "jobs-to-be-done"], phrase: "what they're trying to get done", inPosts: true },
  { concept: "Positioning", terms: ["positioning"], phrase: "your angle", inPosts: false },
  { concept: "Hook", terms: ["hook", "hooks"], phrase: "opening line", inPosts: false },
  { concept: "CTA", terms: ["CTA", "CTAs", "call to action", "call-to-action"], phrase: "what you want them to do next", inPosts: true },
  { concept: "Carousel", terms: ["carousel", "carousels"], phrase: "swipe post", inPosts: false },
  { concept: "UTM", terms: ["UTM", "UTMs"], phrase: "tracking link", inPosts: true },
  { concept: "Impressions", terms: ["impressions"], phrase: "views", inPosts: false },
  { concept: "CTR", terms: ["CTR", "click-through rate", "clickthrough rate"], phrase: "% who tapped the link", inPosts: true },
  { concept: "Conversion", terms: ["conversion", "conversions", "conversion rate"], phrase: "signups / sales", inPosts: false },
  { concept: "ROAS", terms: ["ROAS"], phrase: "$ earned per $1", inPosts: true },
  { concept: "CPA", terms: ["CPA"], phrase: "cost per signup", inPosts: true },
  { concept: "SEO", terms: ["SEO"], phrase: "get found on Google", inPosts: false },
  { concept: "ASO", terms: ["ASO"], phrase: "App Store listing", inPosts: false },
  { concept: "Brand voice", terms: ["brand voice"], phrase: "how you sound", inPosts: false },
  { concept: "Funnel", terms: ["funnel", "funnels"], phrase: "path to signing up", inPosts: true },
  { concept: "Value prop", terms: ["value prop", "value props", "value proposition"], phrase: "the promise", inPosts: true },
];

/** Every banned term, for the copy lint test (apps/web/src/copy.lint.test.ts) and runtime checks. */
export const JARGON_TERMS: readonly string[] = VOCABULARY.flatMap((v) => v.terms);

export type JargonScope = "ui" | "post";

export interface JargonHit {
  term: string;
  phrase: string;
  index: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function entries(scope: JargonScope) {
  // Longest terms first so "conversion rate" wins over "conversion".
  return VOCABULARY.filter((v) => scope === "ui" || v.inPosts)
    .flatMap((v) => v.terms.map((term) => ({ term, phrase: v.phrase })))
    .sort((a, b) => b.term.length - a.term.length);
}

function pattern(scope: JargonScope): RegExp {
  // Whole words: letters, digits or hyphen on either side mean it's part of another word.
  return new RegExp(`(?<![\\p{L}\\p{N}-])(${entries(scope).map((e) => esc(e.term)).join("|")})(?![\\p{L}\\p{N}-])`, "giu");
}

const PATTERNS: Record<JargonScope, RegExp> = { ui: pattern("ui"), post: pattern("post") };

export function findJargon(text: string, scope: JargonScope = "ui"): JargonHit[] {
  const lookup = new Map(entries(scope).map((e) => [e.term.toLowerCase(), e.phrase]));
  const hits: JargonHit[] = [];
  for (const m of text.matchAll(PATTERNS[scope])) {
    hits.push({ term: m[0], phrase: lookup.get(m[0].toLowerCase()) ?? "", index: m.index ?? 0 });
  }
  return hits;
}

const PLURALIZABLE = new Set(["opening line", "swipe post", "tracking link"]);

/**
 * Last-resort swap (§2.6): after one rewrite still leaves jargon, replace each term with its phrase.
 * Keeps a capital at the start of a sentence; plural terms get a plural phrase where it reads right.
 */
export function plainify(text: string, scope: JargonScope = "ui"): string {
  const lookup = new Map(entries(scope).map((e) => [e.term.toLowerCase(), e.phrase]));
  return text.replace(PATTERNS[scope], (match, _g, offset: number) => {
    const lower = match.toLowerCase();
    let phrase = lookup.get(lower) ?? match;
    if (lower.endsWith("s") && lookup.has(lower.slice(0, -1)) && PLURALIZABLE.has(phrase)) phrase += "s";
    const before = text.slice(0, offset).trimEnd();
    const sentenceStart = before === "" || /[.!?:]$/.test(before);
    return sentenceStart ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
  });
}
