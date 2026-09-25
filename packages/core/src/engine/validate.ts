import {
  BODY_MAX_WORDS,
  HEADLINE_MAX_WORDS,
  LINK_TOKEN_RE,
  LINK_TOKENS,
  MAX_SLIDES,
  MIN_SLIDES,
  PLATFORM_LIMITS,
  countChars,
  findJargon,
  plainify,
  textLimit,
  type CarouselSpec,
  type JargonScope,
  type PostFormat,
  type PostVariant,
  type SocialPlatform,
} from "@mkt/contracts";

// Copy validators (§5.4, §5.0 output discipline). Pure. Issues are plain sentences the board shows.

export type Severity = "block" | "warn";

export interface CopyIssue {
  code:
    | "too_long"
    | "too_many_hashtags"
    | "too_similar"
    | "asks_for_votes"
    | "raw_link_removed"
    | "x_link_outside_launch"
    | "unknown_fact"
    | "internal_fact"
    | "rejected_fact"
    | "fact_expires"
    | "number_without_source"
    | "jargon"
    | "empty"
    | "missing_platform"
    | "slide_count"
    | "slide_text_dense";
  severity: Severity;
  message: string;
}

export interface ClaimInfo {
  ref: string;
  publicOk: boolean;
  status: "sourced" | "verified" | "rejected";
  expiresAt: Date | null;
}

export interface ValidateContext {
  platform: SocialPlatform;
  format: PostFormat;
  /** When it posts; claims must stay valid through it. Null for unscheduled drafts. */
  scheduledAt: Date | null;
  /** Every claim of the DNA version (public or not), by ref. */
  claims: ReadonlyMap<string, ClaimInfo>;
  /** Other posts on the same connection (or same platform + product when unconnected) within 14 days. */
  recentTexts: readonly string[];
  /** D24: X links only in launch week (the Upload-Post links add-on). */
  xLinksAllowed: boolean;
}

export const SIMILARITY_LIMIT = 0.6;
export const SIMILARITY_WINDOW_DAYS = 14;

/** Asking for upvotes, likes or reposts: against Reddit/HN rules and a spam signal everywhere. */
export const UPVOTE_RE =
  /\b(up-?vot(e|es|ing)|smash (that|the) like|like and (share|subscribe|retweet|repost)|please (like|retweet|repost|share|boost|upvote)|give (us|me|it|this) an? (upvote|like|star)|(retweet|repost|rt) (if|this|to|for)|drop a like|hit (the )?like)\b/i;

const RAW_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;

/** Letters and digits only, lowercase, single spaces; link tokens removed. */
export function normalizeForSimilarity(s: string): string {
  return s
    .replace(LINK_TOKEN_RE, " ")
    .replace(RAW_URL_RE, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function trigrams(s: string): Set<string> {
  const n = normalizeForSimilarity(s);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= n.length; i++) out.add(n.slice(i, i + 3));
  return out;
}

/** Character-trigram Jaccard similarity, 0..1. */
export function trigramJaccard(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

const words = (s: string | null | undefined) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

/** Caption as it will be posted: text, then the hashtags. Used for counting and by publish.prepare. */
export function composeCaption(text: string, hashtags: readonly string[]): string {
  return hashtags.length ? `${text}\n\n${hashtags.map((h) => `#${h}`).join(" ")}` : text;
}

function stripLinks(text: string, keepTokens: boolean): { text: string; removed: number } {
  let removed = 0;
  let out = text.replace(RAW_URL_RE, () => (removed++, ""));
  out = out.replace(LINK_TOKEN_RE, (m, name: string) => {
    if (keepTokens && (LINK_TOKENS as readonly string[]).includes(name)) return m;
    removed++;
    return "";
  });
  return { text: out.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").trim(), removed };
}

/**
 * Fix what can be fixed without Claude: raw URLs and unknown link tokens removed (links only as
 * `{{link:landing}}`), X links dropped outside launch week, `#` stripped from hashtags, linkToken
 * matching the text.
 */
export function sanitizeVariant(v: PostVariant, ctx: Pick<ValidateContext, "platform" | "xLinksAllowed">): { variant: PostVariant; issues: CopyIssue[] } {
  const issues: CopyIssue[] = [];
  const keepTokens = !(ctx.platform === "x" && !ctx.xLinksAllowed);
  let removed = 0;
  const clean = (s: string) => {
    const r = stripLinks(s, keepTokens);
    removed += r.removed;
    return r.text;
  };
  const hadToken = [v.text, ...v.parts, v.firstComment ?? ""].some((s) => s.includes("{{link:"));
  const parts = v.parts.map(clean).filter(Boolean);
  const text = parts.length ? parts[0]! : clean(v.text);
  const firstComment = v.firstComment === null ? null : clean(v.firstComment) || null;
  const hashtags = [...new Set(v.hashtags.map((h) => h.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))];
  const hasToken = [text, ...parts, firstComment ?? ""].some((s) => s.includes("{{link:landing}}"));
  if (!keepTokens && hadToken) {
    issues.push({ code: "x_link_outside_launch", severity: "warn", message: "X posts point to your bio link except in launch week, so the link was taken out." });
  } else if (removed > 0) {
    issues.push({ code: "raw_link_removed", severity: "warn", message: "A web address was taken out. Links are added for you as a tracking link." });
  }
  return {
    variant: { ...v, text, parts, firstComment, hashtags, linkToken: hasToken ? "{{link:landing}}" : null },
    issues,
  };
}

export function claimIssues(refs: readonly string[], claims: ReadonlyMap<string, ClaimInfo>, scheduledAt: Date | null): CopyIssue[] {
  const out: CopyIssue[] = [];
  for (const ref of new Set(refs)) {
    const c = claims.get(ref);
    if (!c) out.push({ code: "unknown_fact", severity: "block", message: `It leans on a fact we don't have (${ref}).` });
    else if (c.status === "rejected") out.push({ code: "rejected_fact", severity: "block", message: `It uses a fact you marked as wrong (${ref}).` });
    else if (!c.publicOk) out.push({ code: "internal_fact", severity: "block", message: `It uses a private fact that can't be said in public (${ref}).` });
    else if (c.expiresAt && scheduledAt && c.expiresAt.getTime() < scheduledAt.getTime()) {
      out.push({ code: "fact_expires", severity: "block", message: `A fact it uses (${ref}) goes out of date before this posts.` });
    }
  }
  return out;
}

const NUMBERISH = /(\d+(\.\d+)?\s?%|\$\s?\d|\b\d{2,}\b|\b\d+x\b|#1\b|\bbest\b|\bfastest\b)/i;

export function validateVariant(v: PostVariant, ctx: ValidateContext): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const limits = PLATFORM_LIMITS[ctx.platform];
  const limit = textLimit(ctx.platform, ctx.format);
  const parts = v.parts.length ? v.parts : [v.text];
  if (!parts.some((p) => p.trim())) issues.push({ code: "empty", severity: "block", message: "The post is empty." });

  parts.forEach((p, i) => {
    const counted = i === 0 ? composeCaption(p, v.hashtags) : p;
    const n = countChars(ctx.platform, counted);
    if (n > limit) {
      const which = parts.length > 1 ? `Part ${i + 1} is` : "It's";
      issues.push({ code: "too_long", severity: "block", message: `${which} ${n} characters; ${limits.label} allows ${limit}.` });
    }
  });
  if (v.firstComment && countChars(ctx.platform, v.firstComment) > limit) {
    issues.push({ code: "too_long", severity: "block", message: `The first comment is too long for ${limits.label}.` });
  }
  if (limits.hashtags !== null && v.hashtags.length > limits.hashtags) {
    issues.push({ code: "too_many_hashtags", severity: "block", message: `${v.hashtags.length} hashtags; ${limits.label} allows ${limits.hashtags}.` });
  }

  const all = [...parts, v.firstComment ?? "", v.altText ?? ""].join("\n");
  if (UPVOTE_RE.test(all)) issues.push({ code: "asks_for_votes", severity: "block", message: "It asks people to like, upvote or repost. That breaks the rules on most sites." });

  const mine = parts.join("\n");
  const worst = ctx.recentTexts.reduce((m, t) => Math.max(m, trigramJaccard(mine, t)), 0);
  if (worst >= SIMILARITY_LIMIT) {
    issues.push({
      code: "too_similar",
      severity: ctx.platform === "x" ? "block" : "warn",
      message: `It's too close to another post on this account in the same two weeks (${Math.round(worst * 100)}% alike).`,
    });
  }

  issues.push(...claimIssues(v.claimRefs, ctx.claims, ctx.scheduledAt));
  if (!v.claimRefs.length && NUMBERISH.test(mine)) {
    issues.push({ code: "number_without_source", severity: "warn", message: "It has a number or a strong claim with no source attached. Check it's true." });
  }
  const jargon = findJargon(all, "post");
  if (jargon.length) {
    issues.push({ code: "jargon", severity: "warn", message: `Marketing jargon: ${[...new Set(jargon.map((j) => j.term))].join(", ")}.` });
  }
  return issues;
}

/** Swipe-post checks: slide count, text density, and each caption as a post on its platform. */
export function validateCarousel(
  spec: CarouselSpec,
  ctxFor: (platform: SocialPlatform) => ValidateContext | null,
  targets: readonly SocialPlatform[],
): Record<string, CopyIssue[]> {
  const shared: CopyIssue[] = [];
  if (spec.slides.length < MIN_SLIDES || spec.slides.length > MAX_SLIDES) {
    shared.push({ code: "slide_count", severity: "block", message: `A swipe post needs ${MIN_SLIDES}–${MAX_SLIDES} slides; this has ${spec.slides.length}.` });
  }
  spec.slides.forEach((s, i) => {
    if (words(s.headline) > HEADLINE_MAX_WORDS || words(s.body) > BODY_MAX_WORDS) {
      shared.push({ code: "slide_text_dense", severity: "warn", message: `Slide ${i + 1} has a lot of text for a phone screen.` });
    }
  });
  shared.push(...claimIssues(spec.claimRefs, ctxFor(targets[0]!)?.claims ?? new Map(), ctxFor(targets[0]!)?.scheduledAt ?? null));
  const slideText = spec.slides.map((s) => `${s.headline} ${s.body ?? ""}`).join("\n");
  if (UPVOTE_RE.test(slideText)) shared.push({ code: "asks_for_votes", severity: "block", message: "A slide asks people to like or repost." });

  const out: Record<string, CopyIssue[]> = {};
  for (const p of targets) {
    const ctx = ctxFor(p);
    const cap = spec.captions[p];
    if (!ctx || !cap) {
      out[p] = [...shared, { code: "missing_platform", severity: "block", message: `No caption was written for ${PLATFORM_LIMITS[p].label}.` }];
      continue;
    }
    const v: PostVariant = { platform: p, text: cap.text, parts: [], hashtags: cap.hashtags, linkToken: null, altText: spec.altText, firstComment: null, claimRefs: spec.claimRefs };
    out[p] = [...shared, ...validateVariant(v, ctx).filter((i) => !["unknown_fact", "internal_fact", "rejected_fact", "fact_expires"].includes(i.code))];
  }
  return out;
}

export const hasBlock = (issues: readonly CopyIssue[]) => issues.some((i) => i.severity === "block");

/**
 * §2.6 at runtime: jargon triggers one rewrite (the `rewrite` callback, a copy.repair call); if the
 * rewrite still has jargon, the terms are swapped for their plain phrases.
 */
export async function ensurePlain(
  text: string,
  scope: JargonScope,
  rewrite: (text: string, terms: string[]) => Promise<string>,
): Promise<{ text: string; rewritten: boolean; swapped: boolean }> {
  const hits = findJargon(text, scope);
  if (!hits.length) return { text, rewritten: false, swapped: false };
  const again = await rewrite(text, [...new Set(hits.map((h) => h.term))]);
  if (!findJargon(again, scope).length) return { text: again, rewritten: true, swapped: false };
  return { text: plainify(again, scope), rewritten: true, swapped: true };
}
