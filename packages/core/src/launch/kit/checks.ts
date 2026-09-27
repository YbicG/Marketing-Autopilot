import {
  LINK_TOKEN_RE,
  findJargon,
  plainify,
  type AmbassadorKitBody,
  type CreatorKitBody,
  type GeneratedKitKind,
  type KitDisclosure,
  type KitInputs,
  type KitIssue,
  type LaunchKitBody,
  type PressKitBody,
  type ReplyBankBody,
  type SubredditKitBody,
} from "@mkt/contracts";
import { UPVOTE_RE, claimIssues, type ClaimInfo } from "../../engine/validate.ts";
import { MAKER_RE } from "./links.ts";

// Launch kit checks (§5.0 output discipline, §8 endorsements). Pure: issues are plain sentences.

export interface KitClaim extends ClaimInfo {
  kind: string;
}

export interface KitCheckCtx {
  /** Every claim of the bundle's DNA version, by ref. */
  claims: ReadonlyMap<string, KitClaim>;
  /** End of launch day: every fact must stay valid through it. */
  validThrough: Date;
  /** Normalized prices ("$4.99") from the profile's plans and public price facts. */
  knownPrices: ReadonlySet<string>;
  competitors: readonly string[];
  inputs: KitInputs;
  /** Assets the press kit may list. */
  assetIds: ReadonlySet<string>;
}

/** Codes that mean a required disclosure is missing: the kit won't export while any is present. */
export const DISCLOSURE_CODES: ReadonlySet<string> = new Set([
  "no_maker_disclosure",
  "missing_disclosure",
  "caption_without_disclosure",
  "missing_branded_steps",
  "missing_paid_label",
]);

export const REPLY_MAX_CHARS = 500;
export const REDDIT_TITLE_MAX = 300;

const RAW_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
const PLACEHOLDER_RE = /\[[^\]\n]{1,60}\]/g;
const PRICE_RE = /(?:[$€£]\s?\d+(?:[.,]\d{1,2})?|\b\d+(?:[.,]\d{1,2})?\s?(?:USD|dollars?|bucks)\b)/gi;
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{4}-\d{2}-\d{2}\b/gi;
const NUMBERISH =
  /\d+(?:\.\d+)?\s?%|\b\d{2,}\b|\b\d+(?:\.\d+)?\s?(?:x|times)\b|#1\b|\b(?:best|fastest|cheapest|number one|most popular|leading|top-rated|world's)\b/i;
const REVIEW_RE = /★|\b\d(?:\.\d)?\s?(?:\/\s?5|out of 5|stars?)\b|\brated\s+\d|["“][^"”\n]{8,}["”]\s*[-–—]\s*[A-Z][a-z]+/;
const PROMISE_RE =
  /\b(?:guarantee[sd]?|guaranteed|go(?:es)? viral|will blow up|passive income|you(?:'ll| will) (?:earn|make|get) (?:\$|\d|thousands|hundreds))\b/i;
const GREETING_RE = /\b(?:Hi|Hello|Dear|Hey)[ \t]+([A-Z][a-z]{1,20})\b/g;
const GENERIC_GREETING = new Set(["there", "everyone", "all", "team", "folks", "friends", "editors", "editor", "y'all"]);
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export const normalizePrice = (raw: string): string => {
  const cur = /€/.test(raw) ? "€" : /£/.test(raw) ? "£" : "$";
  const n = Number(raw.replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? `${cur}${n.toFixed(2)}` : raw;
};

export function pricesIn(text: string): string[] {
  return [...text.matchAll(PRICE_RE)].map((m) => normalizePrice(m[0]));
}

/** Link hygiene for model output: raw web addresses and unknown link tokens are removed. */
export function sanitizeKitText(s: string): { text: string; removed: number } {
  let removed = 0;
  const out = s
    .replace(RAW_URL_RE, () => (removed++, ""))
    .replace(LINK_TOKEN_RE, (m, name: string) => (name === "landing" ? m : (removed++, "")))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
  return { text: out, removed };
}

/** Keys whose strings are ours (ids, links, names), never rewritten by sanitize or plainify. */
const FIXED_KEYS = new Set(["kind", "schemaVersion", "subreddit", "rulesUrl", "url", "ref", "assetId", "assistedTaskId", "assistedTaskIds", "claimRefs", "lastEditedBy", "outletType", "channel", "source", "links"]);

/** Map every free-text string in a kit body (or model value). */
export function mapKitStrings<T>(value: T, fn: (s: string) => string): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (key && FIXED_KEYS.has(key)) return v;
    if (typeof v === "string") return fn(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, null) as T;
}

export function sanitizeKitStrings<T>(value: T): { value: T; issues: KitIssue[] } {
  let removed = 0;
  const out = mapKitStrings(value, (s) => {
    const r = sanitizeKitText(s);
    removed += r.removed;
    return r.text;
  });
  return {
    value: out,
    issues: removed ? [{ code: "raw_link_removed", severity: "warn", message: "A web address was taken out. Links are added for you as a tracking link." }] : [],
  };
}

/** §2.6 fallback after the one repair: swap any jargon left for the plain phrase. */
export const plainifyKit = <T>(value: T): T => mapKitStrings(value, (s) => plainify(s, "post"));

// ── text units ──

interface Unit {
  where: string;
  text: string;
  claimRefs: readonly string[];
  /** Profile rows (name, price…) are facts from the profile itself. */
  profile?: boolean;
  /** Messages CJ sends to a person: names must be placeholders unless the user gave them. */
  message?: boolean;
}

function unitsOf(body: LaunchKitBody): Unit[] {
  switch (body.kind) {
    case "subreddit":
      return body.drafts.map((d) => ({ where: `The r/${d.subreddit} post`, text: `${d.title}\n${d.body}\n${d.whyThisFits}`, claimRefs: d.claimRefs }));
    case "ambassador": {
      const refs = body.claimRefs;
      return [
        { where: "The pitch", text: body.pitch, claimRefs: refs },
        { where: "What ambassadors get", text: body.perks.join("\n"), claimRefs: refs },
        ...body.templates.map((t, i) => ({ where: `Message ${i + 1}`, text: `${t.subject ?? ""}\n${t.text}`, claimRefs: refs, message: true })),
        { where: "The posting guide", text: body.postingGuide.join("\n"), claimRefs: refs },
        ...body.captionExamples.map((c, i) => ({ where: `Caption example ${i + 1}`, text: c, claimRefs: refs })),
      ];
    }
    case "press":
      return [
        ...body.facts.map((f) => ({ where: `Fact sheet "${f.label}"`, text: `${f.label}: ${f.value}`, claimRefs: f.claimRefs, profile: f.source === "profile" })),
        { where: "The boilerplate", text: body.boilerplate, claimRefs: body.claimRefs },
        { where: "The founder quote", text: body.founderQuote.text, claimRefs: body.claimRefs },
        ...body.pitches.map((p, i) => ({ where: `Pitch ${i + 1}`, text: `${p.subject}\n${p.body}`, claimRefs: p.claimRefs, message: true })),
      ];
    case "creator": {
      const refs = body.claimRefs;
      return [
        { where: "What it is", text: body.whatItIs, claimRefs: refs },
        { where: "What to show", text: body.whatToShow.join("\n"), claimRefs: refs },
        { where: "Dos", text: body.dos.join("\n"), claimRefs: refs },
        { where: "Don'ts", text: body.donts.join("\n"), claimRefs: refs },
        ...body.dmTemplates.map((t, i) => ({ where: `Message ${i + 1}`, text: t.text, claimRefs: refs, message: true })),
      ];
    }
    case "reply_bank":
      return body.replies.map((r, i) => ({ where: `Reply ${i + 1} ("${short(r.trigger)}")`, text: r.reply, claimRefs: r.claimRefs }));
  }
}

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 37)}...` : s);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text the user typed (reward, offer, targets) may hold numbers and names: they're theirs. */
function userPhrases(inputs: KitInputs): string[] {
  return [
    inputs.ambassador?.reward ?? "",
    inputs.creator?.offer ?? "",
    ...(inputs.press?.targets ?? []).flatMap((t) => [t.outlet, t.contactName ?? "", t.email ?? ""]),
    ...(inputs.ambassador?.ambassadors ?? []).map((a) => a.name),
  ].filter((s) => s.trim().length > 1);
}

function unitIssues(u: Unit, ctx: KitCheckCtx, allowedNames: ReadonlySet<string>, allowedEmails: ReadonlySet<string>, mine: string[]): KitIssue[] {
  const out: KitIssue[] = [];
  const text = u.text;
  if (UPVOTE_RE.test(text)) out.push({ code: "asks_for_votes", severity: "block", message: `${u.where} asks people to like, upvote or repost. That breaks the rules on most sites.` });
  if (new RegExp(RAW_URL_RE.source, "i").test(text)) out.push({ code: "raw_link", severity: "block", message: `${u.where} has a typed web address. Use {{link:landing}} instead; it becomes a tracking link.` });
  for (const m of text.matchAll(LINK_TOKEN_RE)) {
    if (m[1] !== "landing") out.push({ code: "unknown_link", severity: "block", message: `${u.where} has a link we can't fill in ("${m[0]}"). Only {{link:landing}} works.` });
  }

  let rest = text.replace(LINK_TOKEN_RE, " ").replace(PLACEHOLDER_RE, " ").replace(TIME_RE, " ");
  for (const p of mine) rest = rest.replace(new RegExp(esc(p), "gi"), " ");
  for (const price of pricesIn(rest)) {
    if (!ctx.knownPrices.has(price)) {
      out.push({ code: "price_not_exact", severity: "block", message: `${u.where} says ${price}, which isn't one of your prices. Prices must match your product profile exactly.` });
    }
  }
  const noPrices = rest.replace(PRICE_RE, (m) => (ctx.knownPrices.has(normalizePrice(m)) ? " " : m));
  if (!u.profile && !u.claimRefs.length && NUMBERISH.test(noPrices)) {
    out.push({ code: "number_without_source", severity: "block", message: `${u.where} has a number or a strong claim with no fact behind it. Use a fact from your profile or take it out.` });
  }
  if (!u.claimRefs.length) {
    const named = ctx.competitors.find((c) => c.trim().length > 2 && new RegExp(`(?<![\\p{L}\\p{N}])${esc(c.trim())}(?![\\p{L}\\p{N}])`, "iu").test(rest));
    if (named) out.push({ code: "competitor_without_source", severity: "block", message: `${u.where} says something about ${named} with no fact behind it.` });
  }
  if (REVIEW_RE.test(rest)) out.push({ code: "invented_review", severity: "block", message: `${u.where} looks like a review, rating or quote from a user. Only real, verified ones can be used.` });

  if (u.message) {
    for (const m of text.matchAll(GREETING_RE)) {
      const name = m[1]!;
      if (!GENERIC_GREETING.has(name.toLowerCase()) && !allowedNames.has(name.toLowerCase())) {
        out.push({ code: "invented_name", severity: "block", message: `${u.where} greets "${name}", a name you didn't give. Use a placeholder like [Name].` });
      }
    }
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!allowedEmails.has(m[0].toLowerCase())) out.push({ code: "invented_contact", severity: "block", message: `${u.where} has an email address you didn't give (${m[0]}).` });
  }

  const jargon = findJargon(text, "post");
  if (jargon.length) out.push({ code: "jargon", severity: "warn", message: `${u.where} uses marketing jargon: ${[...new Set(jargon.map((j) => j.term))].join(", ")}.` });
  return out;
}

function factIssues(refs: readonly string[], ctx: KitCheckCtx): KitIssue[] {
  const out: KitIssue[] = claimIssues(refs, ctx.claims, ctx.validThrough).map((i) => ({ code: i.code, severity: i.severity, message: i.message.replace("before this posts", "before launch day") }));
  for (const ref of new Set(refs)) {
    const c = ctx.claims.get(ref);
    if (c && c.kind === "testimonial" && c.status !== "verified") {
      out.push({ code: "unverified_testimonial", severity: "block", message: `It uses a testimonial you haven't verified yet (${ref}).` });
    }
  }
  return out;
}

function disclosureIssues(where: string, d: KitDisclosure, captions: readonly string[], steps: readonly string[], paidLabel: boolean): KitIssue[] {
  const out: KitIssue[] = [];
  if (!/#ad\b/i.test(d.captionPrefix) && !/\breward\b/i.test(d.captionPrefix)) {
    out.push({ code: "missing_disclosure", severity: "block", message: `${where}: the caption disclosure must say "#ad" or that they get a reward.` });
  }
  const prefix = d.captionPrefix.trim().toLowerCase();
  captions.forEach((c, i) => {
    const head = c.trim().toLowerCase();
    if (!head.startsWith(prefix) && !/^#ad\b/.test(head)) {
      out.push({ code: "caption_without_disclosure", severity: "block", message: `Caption example ${i + 1} doesn't start with the disclosure ("${d.captionPrefix}").` });
    }
  });
  if (!steps.some((s) => /branded content/i.test(s))) {
    out.push({ code: "missing_branded_steps", severity: "block", message: `${where}: the TikTok branded content steps are missing.` });
  }
  if (paidLabel && !d.rules.some((r) => /paid partnership|paid promotion/i.test(r))) {
    out.push({ code: "missing_paid_label", severity: "block", message: `${where}: say to turn on the paid partnership label.` });
  }
  return out;
}

function kindIssues(body: LaunchKitBody, ctx: KitCheckCtx): KitIssue[] {
  const out: KitIssue[] = [];
  switch (body.kind) {
    case "subreddit":
      return subredditIssues(body, ctx);
    case "ambassador":
      return ambassadorIssues(body, ctx);
    case "press":
      return pressIssues(body, ctx);
    case "creator":
      return creatorIssues(body);
    case "reply_bank":
      return replyIssues(body);
  }
  return out;
}

function subredditIssues(body: SubredditKitBody, ctx: KitCheckCtx): KitIssue[] {
  const out: KitIssue[] = [];
  const chosen = new Set((ctx.inputs.subreddit?.communities ?? []).map((c) => c.toLowerCase()));
  for (const d of body.drafts) {
    const where = `The r/${d.subreddit} post`;
    if (d.title.length > REDDIT_TITLE_MAX) out.push({ code: "too_long", severity: "block", message: `${where} has a title of ${d.title.length} characters; Reddit allows ${REDDIT_TITLE_MAX}.` });
    if (!MAKER_RE.test(d.body)) out.push({ code: "no_maker_disclosure", severity: "block", message: `${where} doesn't say you made the app. Add something like "I made this".` });
    if (d.likelyNotAllowed) out.push({ code: "likely_not_allowed", severity: "warn", message: `${where}: the rules seem to forbid posts like this. Read them before you use it.` });
    if (d.proposed || !chosen.has(d.subreddit.toLowerCase())) {
      out.push({ code: "community_unchecked", severity: "warn", message: `Check r/${d.subreddit} exists and allows posts like this before you use it.` });
    }
  }
  return out;
}

function ambassadorIssues(body: AmbassadorKitBody, ctx: KitCheckCtx): KitIssue[] {
  const out = disclosureIssues("Ambassador kit", body.disclosure, body.captionExamples, body.brandedContentSteps, false);
  if (body.templates.length !== 3) out.push({ code: "template_count", severity: "warn", message: `There are ${body.templates.length} messages; the kit usually has 3.` });
  if (!body.links.length) out.push({ code: "no_links", severity: "warn", message: "No referral links yet. Add your ambassadors' names to make one each." });
  if (!ctx.inputs.ambassador?.reward && !body.perks.some((p) => p.includes("["))) {
    out.push({ code: "perks_unconfirmed", severity: "warn", message: "Check \"What ambassadors get\" is what you'll really give them." });
  }
  const all = [body.pitch, ...body.perks, ...body.templates.map((t) => t.text), ...body.postingGuide, ...body.captionExamples].join("\n");
  if (PROMISE_RE.test(all)) out.push({ code: "promises_results", severity: "block", message: "The kit promises results (earnings, views). Take that out." });
  return out;
}

function pressIssues(body: PressKitBody, ctx: KitCheckCtx): KitIssue[] {
  const out: KitIssue[] = [];
  const targets = ctx.inputs.press?.targets ?? [];
  const outlets = new Set(targets.map((t) => t.outlet.trim().toLowerCase()));
  if (body.pitches.length !== 10) out.push({ code: "pitch_count", severity: "warn", message: `There are ${body.pitches.length} pitches; the kit usually has 10.` });
  body.pitches.forEach((p, i) => {
    const where = `Pitch ${i + 1}`;
    if (!p.outlet.includes("[") && !outlets.has(p.outlet.trim().toLowerCase())) {
      out.push({ code: "invented_outlet", severity: "block", message: `${where} names "${p.outlet}", an outlet you didn't give. Use [Outlet] or add it to your list.` });
    }
    if (!MAKER_RE.test(p.body)) out.push({ code: "no_maker_disclosure", severity: "block", message: `${where} doesn't say you made the app. Add something like "I built this".` });
  });
  if (body.founderQuote.editMe) out.push({ code: "edit_founder_quote", severity: "warn", message: "Edit the founder quote so it's in your own words." });
  for (const a of body.assets) {
    if (!ctx.assetIds.has(a.assetId)) out.push({ code: "unknown_asset", severity: "block", message: `The file "${a.label}" isn't in your library any more.` });
  }
  return out;
}

function creatorIssues(body: CreatorKitBody): KitIssue[] {
  const out = disclosureIssues("Creator brief", body.disclosure, [], body.brandedContentSteps, true);
  if (body.dmTemplates.length !== 3) out.push({ code: "template_count", severity: "warn", message: `There are ${body.dmTemplates.length} messages; the brief usually has 3.` });
  const all = [body.whatItIs, ...body.whatToShow, ...body.dos, ...body.dmTemplates.map((t) => t.text)].join("\n");
  if (PROMISE_RE.test(all)) out.push({ code: "promises_results", severity: "block", message: "The brief promises results (views, sales, earnings). Take that out." });
  return out;
}

function replyIssues(body: ReplyBankBody): KitIssue[] {
  const out: KitIssue[] = [];
  let withLinks = 0;
  body.replies.forEach((r, i) => {
    const where = `Reply ${i + 1} ("${short(r.trigger)}")`;
    const links = [...r.reply.matchAll(LINK_TOKEN_RE)].length;
    if (links) withLinks++;
    if (links > 1) out.push({ code: "link_spam", severity: "block", message: `${where} has more than one link.` });
    if (links && !MAKER_RE.test(r.reply)) out.push({ code: "no_maker_disclosure", severity: "block", message: `${where} links to the app without saying you made it.` });
    if (r.reply.length > REPLY_MAX_CHARS) out.push({ code: "long_reply", severity: "warn", message: `${where} is long for a comment reply.` });
  });
  if (body.replies.length >= 4 && withLinks > body.replies.length / 2) {
    out.push({ code: "link_heavy", severity: "warn", message: "Most replies carry a link. That reads like spam; keep links for when someone asks." });
  }
  return out;
}

function claimRefsOf(body: LaunchKitBody): string[] {
  switch (body.kind) {
    case "subreddit":
      return body.drafts.flatMap((d) => d.claimRefs);
    case "press":
      return [...body.claimRefs, ...body.facts.flatMap((f) => f.claimRefs), ...body.pitches.flatMap((p) => p.claimRefs)];
    case "reply_bank":
      return body.replies.flatMap((r) => r.claimRefs);
    default:
      return body.claimRefs;
  }
}

/** Every claim ref the body cites (for launch_kits.claim_ids). */
export const kitClaimRefs = (body: LaunchKitBody): string[] => [...new Set(claimRefsOf(body))];

/** All checks for one kit body. */
export function validateKitBody(body: LaunchKitBody, ctx: KitCheckCtx): KitIssue[] {
  const names = new Set<string>();
  for (const t of ctx.inputs.press?.targets ?? []) if (t.contactName) names.add(t.contactName.split(/\s+/)[0]!.toLowerCase());
  for (const a of ctx.inputs.ambassador?.ambassadors ?? []) names.add(a.name.split(/\s+/)[0]!.toLowerCase());
  const emails = new Set((ctx.inputs.press?.targets ?? []).map((t) => t.email?.toLowerCase()).filter((e): e is string => !!e));
  const mine = userPhrases(ctx.inputs);
  // Prices the user typed (the reward, the creator offer) are theirs to state.
  const known: KitCheckCtx = { ...ctx, knownPrices: new Set([...ctx.knownPrices, ...mine.flatMap(pricesIn)]) };
  const issues = [...unitsOf(body).flatMap((u) => unitIssues(u, known, names, emails, mine)), ...factIssues(kitClaimRefs(body), ctx), ...kindIssues(body, ctx)];
  // One sentence per problem.
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.message) ? false : (seen.add(i.message), true)));
}

export const kitHasBlock = (issues: readonly KitIssue[]) => issues.some((i) => i.severity === "block");

/** §8: every required disclosure is present. */
export const disclosuresOk = (issues: readonly KitIssue[]) => !issues.some((i) => DISCLOSURE_CODES.has(i.code));

/** Why the kit can't be exported yet, or null. */
export function exportBlocker(kind: GeneratedKitKind | "ads_export", status: string, issues: readonly KitIssue[], discOk: boolean): string | null {
  if (status === "generating" || status === "planned") return "This kit is still being written.";
  if (status === "failed") return "This kit didn't finish. Make it again.";
  if (!discOk) {
    const d = issues.find((i) => DISCLOSURE_CODES.has(i.code));
    return `This kit can't be downloaded until every disclosure is in place${d ? `: ${d.message}` : "."}`;
  }
  const b = issues.find((i) => i.severity === "block");
  if (b) return `Fix this first: ${b.message}`;
  if (kind === "ads_export" && status !== "ready") return "The ads kit isn't ready yet.";
  return null;
}
