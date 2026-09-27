import {
  ADS_LIMITS,
  findJargon,
  LINK_TOKEN_RE,
  plainify,
  type AdConcept,
  type AdConceptModel,
  type AdCopy,
  type AdCopyField,
  type AdPlatform,
} from "@mkt/contracts";
import { UPVOTE_RE } from "../engine/validate.ts";

// Ads checks (§8 rows: fake testimonials/numbers, third-party sources, ad spend). Pure. Every block
// keeps the kit out of "ready", so nothing that fails here can be exported.

/** Same shape as launch_kits.issues. */
export interface AdIssue {
  code: string;
  message: string;
  severity: "block" | "warn";
}

export interface AdClaim {
  ref: string;
  kind: string;
  text: string;
  quote: string | null;
  publicOk: boolean;
  status: "sourced" | "verified" | "rejected";
  expiresAt: Date | null;
}

export interface AdsCheckCtx {
  claims: ReadonlyMap<string, AdClaim>;
  /** The end of launch day in the workspace time zone: every fact must still be true then. */
  validThrough: Date;
  /** Researched complaints, competitor descriptions and review quotes. Ads never quote any of it. */
  thirdPartyTexts: readonly string[];
}

const RAW_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
/** Numbers, prices, percentages, multipliers and superlatives: each needs a public fact behind it. */
export const AD_NUMBERISH = /(\d+(\.\d+)?\s?%|\$\s?\d|\b\d{2,}\b|\b\d+(\.\d+)?x\b|#1\b|\bbest\b|\bfastest\b|\bcheapest\b|\bnumber one\b|\b(most|top)[- ]rated\b)/i;
const QUOTED_RE = /[“"«„]([^“”"«»„]{1,400})[”"»“]/g;
const QUOTE_MIN_WORDS = 4;
const SHINGLE = 6;

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

function shingles(s: string, n = SHINGLE): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Links go in the platform's website field, never in ad text; jargon is swapped for plain words. */
export function sanitizeAdText(s: string | null): { text: string | null; linkRemoved: boolean; plainSwapped: boolean } {
  if (s === null) return { text: null, linkRemoved: false, plainSwapped: false };
  let linkRemoved = false;
  let out = s.replace(RAW_URL_RE, () => ((linkRemoved = true), "")).replace(LINK_TOKEN_RE, () => ((linkRemoved = true), ""));
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").trim();
  const plainSwapped = findJargon(out, "post").length > 0;
  if (plainSwapped) out = plainify(out, "post");
  return { text: out || null, linkRemoved, plainSwapped };
}

/** Claim refs an ad may lean on: public, not rejected, valid through launch day, testimonials verified. */
export function adClaimIssues(refs: readonly string[], ctx: AdsCheckCtx, where: string): AdIssue[] {
  const out: AdIssue[] = [];
  for (const ref of new Set(refs)) {
    const c = ctx.claims.get(ref);
    if (!c) out.push({ code: "unknown_fact", severity: "block", message: `${where} leans on a fact we don't have (${ref}).` });
    else if (c.status === "rejected") out.push({ code: "rejected_fact", severity: "block", message: `${where} uses a fact you marked as wrong (${ref}).` });
    else if (!c.publicOk) out.push({ code: "internal_fact", severity: "block", message: `${where} uses a private fact that can't be said in public (${ref}).` });
    else if (c.expiresAt && c.expiresAt.getTime() < ctx.validThrough.getTime()) {
      out.push({ code: "fact_expires", severity: "block", message: `${where} uses a fact (${ref}) that goes out of date before launch day ends.` });
    } else if (c.kind === "testimonial" && c.status !== "verified") {
      out.push({ code: "testimonial_unverified", severity: "block", message: `${where} uses a testimonial you haven't checked (${ref}). Ads can only use ones you've verified.` });
    }
  }
  return out;
}

/** Quotes, third-party wording, vote requests and unsourced numbers in one piece of ad text. */
export function adTextIssues(text: string, claimRefs: readonly string[], ctx: AdsCheckCtx, where: string): AdIssue[] {
  const out: AdIssue[] = [];
  for (const m of text.matchAll(QUOTED_RE)) {
    if (words(m[1]!).length >= QUOTE_MIN_WORDS) {
      out.push({ code: "quote_in_ad", severity: "block", message: `${where} quotes someone. Ads can't quote reviews or other people's posts; say it in your own words.` });
      break;
    }
  }
  const mine = shingles(text);
  if (mine.size && ctx.thirdPartyTexts.some((t) => [...shingles(t)].some((s) => mine.has(s)))) {
    out.push({ code: "third_party_text", severity: "block", message: `${where} repeats someone else's words (a review, complaint or competitor page). Ads must use your own words.` });
  }
  if (UPVOTE_RE.test(text)) out.push({ code: "asks_for_votes", severity: "block", message: `${where} asks people to like, upvote or share.` });
  if (!claimRefs.length && AD_NUMBERISH.test(text)) {
    out.push({ code: "number_without_source", severity: "block", message: `${where} has a number or a strong claim with no fact behind it. Ads can only use facts from your profile.` });
  }
  return out;
}

const FIELDS: AdCopyField[] = ["primaryText", "headline", "description"];

/** One ad's copy on one platform: sanitized, then limits, required fields, button and content checks. */
export function checkAdCopy(copy: AdCopy, platform: AdPlatform, ctx: AdsCheckCtx, where: string): { copy: AdCopy; issues: AdIssue[] } {
  const limits = ADS_LIMITS[platform];
  const issues: AdIssue[] = [];
  const next: AdCopy = { ...copy };
  let linkRemoved = false;
  let swapped = false;
  for (const f of FIELDS) {
    const spec = limits.fields[f];
    if (!spec) {
      next[f] = null;
      continue;
    }
    const s = sanitizeAdText(copy[f]);
    linkRemoved ||= s.linkRemoved;
    swapped ||= s.plainSwapped;
    next[f] = s.text;
    if (!s.text) {
      if (spec.required) issues.push({ code: "missing_field", severity: "block", message: `${where} has no ${spec.label.toLowerCase()}.` });
      continue;
    }
    const n = s.text.length;
    if (n > spec.max) issues.push({ code: "too_long", severity: "block", message: `${where}: the ${spec.label.toLowerCase()} is ${n} characters; ${limits.label} allows ${spec.max}.` });
    else if (spec.recommended && n > spec.recommended) {
      issues.push({ code: "long_for_placement", severity: "warn", message: `${where}: the ${spec.label.toLowerCase()} is ${n} characters; ${limits.label} cuts it off after about ${spec.recommended}.` });
    }
  }
  if (!limits.ctas.length) next.callToAction = null;
  else if (!next.callToAction || !limits.ctas.some((c) => c.toLowerCase() === next.callToAction!.toLowerCase())) {
    if (next.callToAction) issues.push({ code: "button_changed", severity: "warn", message: `${where}: "${next.callToAction}" isn't a ${limits.label} button, so it's "${limits.ctas[0]}".` });
    next.callToAction = limits.ctas[0]!;
  } else next.callToAction = limits.ctas.find((c) => c.toLowerCase() === next.callToAction!.toLowerCase())!;

  if (linkRemoved) issues.push({ code: "raw_link_removed", severity: "warn", message: `${where}: a web address was taken out. The link goes in the platform's website field.` });
  if (swapped) issues.push({ code: "jargon", severity: "warn", message: `${where}: marketing jargon was swapped for plain words.` });

  const text = FIELDS.map((f) => next[f]).filter(Boolean).join("\n");
  next.claimRefs = [...new Set(copy.claimRefs.filter((r) => /^C\d+$/.test(r)))];
  issues.push(...adTextIssues(text, next.claimRefs, ctx, where), ...adClaimIssues(next.claimRefs, ctx, where));
  return { copy: next, issues };
}

/** One concept from ads.concepts: unknown picture ids dropped, then the same content checks. */
export function checkConcept(
  m: AdConceptModel,
  idx: number,
  ctx: AdsCheckCtx,
  visuals: { assetIds: ReadonlySet<string>; renderIds: ReadonlySet<string> },
): { concept: AdConcept; issues: AdIssue[] } {
  const where = `Idea ${idx + 1}`;
  const issues: AdIssue[] = [];
  const opening = sanitizeAdText(m.openingLine);
  const angle = sanitizeAdText(m.angle);
  const why = sanitizeAdText(m.why);
  const assetIds = [...new Set(m.assetIds)].filter((id) => visuals.assetIds.has(id));
  const renderIds = [...new Set(m.renderIds)].filter((id) => visuals.renderIds.has(id));
  if (assetIds.length + renderIds.length < new Set([...m.assetIds, ...m.renderIds]).size) {
    issues.push({ code: "unknown_visual", severity: "warn", message: `${where} picked a picture we don't have; it was left out.` });
  }
  if (!assetIds.length && !renderIds.length) {
    issues.push({ code: "no_visual", severity: "warn", message: `${where} has no screenshot or video yet. Add one before you upload it.` });
  }
  const claimRefs = [...new Set(m.claimRefs.filter((r) => /^C\d+$/.test(r)))];
  const concept: AdConcept = {
    idx,
    angle: angle.text ?? "",
    openingLine: opening.text ?? "",
    visual: { assetIds, renderIds, description: m.visualDescription.trim() },
    why: why.text ?? "",
    claimRefs,
  };
  if (!concept.openingLine || !concept.angle) issues.push({ code: "empty", severity: "block", message: `${where} is missing its opening line.` });
  issues.push(...adTextIssues(`${concept.angle}\n${concept.openingLine}`, claimRefs, ctx, where), ...adClaimIssues(claimRefs, ctx, where));
  return { concept, issues };
}

/** Apple Search Ads keywords: trimmed, lower-cased, deduped, within the length limit, no competitor names. */
export function checkKeywords(keywords: readonly string[], competitorNames: readonly string[]): { keywords: string[]; issues: AdIssue[] } {
  const max = ADS_LIMITS.apple_search_ads.keyword?.max ?? 80;
  const banned = competitorNames.map((n) => n.toLowerCase().trim()).filter((n) => n.length >= 3);
  const issues: AdIssue[] = [];
  const out: string[] = [];
  for (const k of keywords) {
    const kw = k.toLowerCase().replace(/\s+/g, " ").trim();
    if (!kw || out.includes(kw)) continue;
    if (kw.length > max) continue;
    if (banned.some((b) => kw.includes(b))) {
      issues.push({ code: "competitor_keyword", severity: "warn", message: `The keyword "${kw}" names another product, so it was left out.` });
      continue;
    }
    out.push(kw);
  }
  return { keywords: out, issues };
}

export const adsHaveBlock = (issues: readonly AdIssue[]) => issues.some((i) => i.severity === "block");
