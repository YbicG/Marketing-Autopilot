import {
  FOUNDER_QUOTE_NOTE,
  KIT_BODY_SCHEMAS,
  SUBREDDIT_RE,
  type AmbassadorKitBody,
  type AmbassadorKitModel,
  type AmbassadorLink,
  type CreatorKitBody,
  type CreatorKitModel,
  type GeneratedKitKind,
  type KitInputs,
  type KitIssue,
  type LaunchKitBody,
  type PressFact,
  type PressKitBody,
  type PressKitModel,
  type ProductDna,
  type ReplyBankBody,
  type ReplyBankModel,
  type SubredditDraft,
  type SubredditKitBody,
  type SubredditKitModel,
} from "@mkt/contracts";
import { sanitizeKitStrings } from "./checks.ts";
import { AMBASSADOR_DISCLOSURE, TIKTOK_BRANDED_CONTENT_STEPS, ambassadorLink, ambassadorRef, creatorDisclosure } from "./links.ts";

// Model output → the stored kit body (pure). Links, disclosures and profile rows are ours, not the model's.

export interface KitAsset {
  id: string;
  kind: string;
  label: string;
}

export interface BuildCtx {
  productName: string;
  /** The product's website, for referral links. */
  site: string | null;
  /** utm_campaign for this launch, e.g. "syllacal-launch". */
  campaign: string;
  inputs: KitInputs;
  dna: ProductDna | null;
  assets: readonly KitAsset[];
}

export type KitModelValue = SubredditKitModel | AmbassadorKitModel | PressKitModel | CreatorKitModel | ReplyBankModel;

export interface Built {
  body: LaunchKitBody | null;
  issues: KitIssue[];
  error: string | null;
}

const refs = (xs: readonly string[]) => [...new Set(xs.filter((c) => /^C\d+$/.test(c)))];
const clean = (xs: readonly string[]) => xs.map((s) => s.trim()).filter(Boolean);
export const subredditName = (s: string) => s.trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");
export const rulesUrlFor = (sub: string) => `https://www.reddit.com/r/${sub}/about/rules`;

export const CHECK_COMMUNITY_NOTE = "Check this community exists and allows posts like this before you use it.";

export function buildKitBody(kind: GeneratedKitKind, model: KitModelValue, ctx: BuildCtx): Built {
  const s = sanitizeKitStrings(model);
  const issues = [...s.issues];
  let body: LaunchKitBody | null;
  switch (kind) {
    case "subreddit":
      body = subredditBody(s.value as SubredditKitModel, ctx);
      break;
    case "ambassador":
      body = ambassadorBody(s.value as AmbassadorKitModel, ctx, issues);
      break;
    case "press":
      body = pressBody(s.value as PressKitModel, ctx);
      break;
    case "creator":
      body = creatorBody(s.value as CreatorKitModel, ctx);
      break;
    case "reply_bank":
      body = replyBody(s.value as ReplyBankModel);
      break;
  }
  const parsed = KIT_BODY_SCHEMAS[kind].safeParse(body);
  if (!parsed.success) return { body: null, issues, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400) };
  return { body: parsed.data as LaunchKitBody, issues, error: null };
}

function subredditBody(m: SubredditKitModel, ctx: BuildCtx): SubredditKitBody {
  const chosen = ctx.inputs.subreddit?.communities ?? [];
  const byLower = new Map(chosen.map((c) => [c.toLowerCase(), c]));
  const seen = new Set<string>();
  const drafts: SubredditDraft[] = [];
  for (const d of m.drafts) {
    const raw = subredditName(d.subreddit);
    if (!SUBREDDIT_RE.test(raw)) continue;
    const given = byLower.get(raw.toLowerCase());
    if (chosen.length && !given) continue; // the user picked the communities: nothing else
    const sub = given ?? raw;
    if (seen.has(sub.toLowerCase())) continue;
    seen.add(sub.toLowerCase());
    drafts.push({
      subreddit: sub,
      title: d.title.trim(),
      body: d.body.trim(),
      whyThisFits: d.whyThisFits.trim(),
      bestTime: d.bestTime.trim(),
      rulesUrl: rulesUrlFor(sub),
      claimRefs: refs(d.claimRefs),
      likelyNotAllowed: d.likelyNotAllowed,
      proposed: !given,
      checkNote: given ? null : CHECK_COMMUNITY_NOTE,
      assistedTaskId: null,
    });
  }
  return { schemaVersion: 1, kind: "subreddit", drafts, assistedTaskIds: [] };
}

/** One link per ambassador the user named; codes made from names when not given. */
export function ambassadorLinks(ctx: Pick<BuildCtx, "site" | "campaign" | "inputs">): AmbassadorLink[] {
  const people = ctx.inputs.ambassador?.ambassadors ?? [];
  if (!ctx.site) return [];
  const taken = new Set(people.map((p) => p.ref).filter((r): r is string => !!r));
  return people.map((p) => {
    const ref = p.ref ?? ambassadorRef(p.name, taken);
    return { name: p.name, ref, url: ambassadorLink(ctx.site!, ref, { campaign: ctx.campaign }) };
  });
}

function ambassadorBody(m: AmbassadorKitModel, ctx: BuildCtx, issues: KitIssue[]): AmbassadorKitBody {
  let links: AmbassadorLink[] = [];
  try {
    links = ambassadorLinks(ctx);
  } catch (err) {
    issues.push({ code: "bad_site", severity: "warn", message: err instanceof Error ? err.message : String(err) });
  }
  if (!ctx.site && ctx.inputs.ambassador?.ambassadors.length) {
    issues.push({ code: "no_site", severity: "warn", message: "Add your website address to the product so each ambassador gets a link." });
  }
  return {
    schemaVersion: 1,
    kind: "ambassador",
    pitch: m.pitch.trim(),
    perks: clean(m.perks),
    templates: m.templates.filter((t) => t.text.trim()).map((t) => ({ channel: t.channel, subject: t.subject?.trim() || null, text: t.text.trim() })),
    postingGuide: clean(m.postingGuide),
    captionExamples: clean(m.captionExamples),
    disclosure: AMBASSADOR_DISCLOSURE,
    brandedContentSteps: [...TIKTOK_BRANDED_CONTENT_STEPS],
    links,
    claimRefs: refs(m.claimRefs),
  };
}

/** Name, what it is, who it's for and exact prices come from the profile, never from the model. */
export function profileFacts(dna: ProductDna | null, productName: string): PressFact[] {
  const rows: PressFact[] = [{ label: "Name", value: dna?.identity.name || productName, claimRefs: [], source: "profile" }];
  if (!dna) return rows;
  if (dna.identity.oneLiner) rows.push({ label: "What it is", value: dna.identity.oneLiner, claimRefs: [], source: "profile" });
  if (dna.identity.whoItsFor) rows.push({ label: "Who it's for", value: dna.identity.whoItsFor, claimRefs: [], source: "profile" });
  if (dna.identity.platforms.length) rows.push({ label: "Works on", value: dna.identity.platforms.join(", "), claimRefs: [], source: "profile" });
  for (const t of dna.offer.pricing.tiers) {
    if (!t.price.trim()) continue;
    rows.push({ label: `Price: ${t.name}`, value: [t.price, t.period].filter(Boolean).join(" "), claimRefs: [], source: "profile" });
  }
  rows.push({ label: "Website", value: "{{link:landing}}", claimRefs: [], source: "profile" });
  return rows;
}

function pressBody(m: PressKitModel, ctx: BuildCtx): PressKitBody {
  const profile = profileFacts(ctx.dna, ctx.productName);
  const taken = new Set(profile.map((f) => f.label.toLowerCase()));
  const facts: PressFact[] = [
    ...profile,
    ...m.facts
      .filter((f) => f.label.trim() && f.value.trim() && !taken.has(f.label.trim().toLowerCase()) && !/^price\b/i.test(f.label.trim()))
      .map((f) => ({ label: f.label.trim(), value: f.value.trim(), claimRefs: refs(f.claimRefs), source: "fact" as const })),
  ];
  const byId = new Map(ctx.assets.map((a) => [a.id, a]));
  const picked = m.assets.filter((a) => byId.has(a.assetId));
  const assets = (picked.length ? picked.map((a) => ({ id: a.assetId, label: a.label.trim() || byId.get(a.assetId)!.label })) : ctx.assets.slice(0, 8).map((a) => ({ id: a.id, label: a.label })))
    .filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i)
    .map((a) => ({ assetId: a.id, label: a.label, kind: byId.get(a.id)!.kind }));
  return {
    schemaVersion: 1,
    kind: "press",
    facts,
    boilerplate: m.boilerplate.trim(),
    founderQuote: { text: m.founderQuote.trim(), editMe: true, note: FOUNDER_QUOTE_NOTE },
    assets,
    pitches: m.pitches
      .filter((p) => p.body.trim() && p.subject.trim())
      .slice(0, 12)
      .map((p) => ({ outletType: p.outletType, outlet: p.outlet.trim() || "[Outlet]", subject: p.subject.trim(), body: p.body.trim(), claimRefs: refs(p.claimRefs) })),
    claimRefs: refs(m.claimRefs),
  };
}

function creatorBody(m: CreatorKitModel, ctx: BuildCtx): CreatorKitBody {
  return {
    schemaVersion: 1,
    kind: "creator",
    whatItIs: m.whatItIs.trim(),
    whatToShow: clean(m.whatToShow),
    dos: clean(m.dos),
    donts: clean(m.donts),
    disclosure: creatorDisclosure(ctx.productName),
    brandedContentSteps: [...TIKTOK_BRANDED_CONTENT_STEPS],
    dmTemplates: m.dmTemplates.map((t) => ({ text: t.text.trim() })).filter((t) => t.text),
    claimRefs: refs(m.claimRefs),
  };
}

function replyBody(m: ReplyBankModel): ReplyBankBody {
  return {
    schemaVersion: 1,
    kind: "reply_bank",
    replies: m.replies.filter((r) => r.trigger.trim() && r.reply.trim()).map((r) => ({ trigger: r.trigger.trim(), reply: r.reply.trim(), claimRefs: refs(r.claimRefs) })),
  };
}
