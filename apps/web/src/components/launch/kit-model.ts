import {
  KIT_KINDS,
  PRESS_OUTLET_TYPES,
  REFERRAL_REF_RE,
  SUBREDDIT_RE,
  type KitInputs,
  type KitKind,
  type PressOutletType,
} from "@mkt/contracts";

// Pure helpers for the launch kit pages: the "tell us more" inputs as the person types them, and
// the conversion to the KitInputs contract that createKitRun parses. Client-safe (contracts only).

export interface PressTargetDraft {
  outlet: string;
  kind: PressOutletType;
  contactName: string;
  email: string;
}

export interface InputDraft {
  /** Communities, one per line or comma-separated, with or without r/. */
  communities: string;
  /** yyyy-mm-dd or empty (launch day). */
  dueDate: string;
  /** One per line: "Name" or "Name, ref". */
  ambassadors: string;
  reward: string;
  targets: PressTargetDraft[];
  offer: string;
  /** One question per line. */
  extraQuestions: string;
}

export const OUTLET_LABEL: Record<PressOutletType, string> = {
  student_newsletter: "Student newsletter",
  campus_paper: "Campus paper",
  podcast: "Podcast",
  other: "Other",
};

export const KIND_ORDER: readonly KitKind[] = KIT_KINDS;
export const isKitKind = (s: string): s is KitKind => (KIT_KINDS as readonly string[]).includes(s);

/** URL segment ↔ kind ("reply-bank" reads nicer in the address bar than "reply_bank"). */
export const kindSlug = (k: KitKind) => k.replace(/_/g, "-");
export const kindFromSlug = (s: string): KitKind | null => {
  const k = s.replace(/-/g, "_");
  return isKitKind(k) ? k : null;
};

export const emptyTarget = (): PressTargetDraft => ({ outlet: "", kind: "student_newsletter", contactName: "", email: "" });

export function draftFromInputs(i: KitInputs): InputDraft {
  return {
    communities: (i.subreddit?.communities ?? []).join("\n"),
    dueDate: i.subreddit?.dueDate ?? "",
    ambassadors: (i.ambassador?.ambassadors ?? []).map((a) => (a.ref ? `${a.name}, ${a.ref}` : a.name)).join("\n"),
    reward: i.ambassador?.reward ?? "",
    targets: (i.press?.targets ?? []).map((t) => ({ outlet: t.outlet, kind: t.kind, contactName: t.contactName ?? "", email: t.email ?? "" })),
    offer: i.creator?.offer ?? "",
    extraQuestions: (i.reply_bank?.extraQuestions ?? []).join("\n"),
  };
}

const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const orNull = (s: string) => (s.trim() ? s.trim() : null);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const subredditOf = (s: string) => s.trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");

/**
 * The inputs for just the kinds being written (other kinds' leftovers never block this run), or
 * the first thing to fix as a plain sentence.
 */
export function inputsFor(kinds: readonly KitKind[], d: InputDraft): { inputs: KitInputs; error: null } | { inputs: null; error: string } {
  const out: KitInputs = {};
  for (const kind of kinds) {
    if (kind === "subreddit") {
      const communities = [...new Set(d.communities.split(/[\n,]+/).map(subredditOf).filter(Boolean))];
      const bad = communities.find((c) => !SUBREDDIT_RE.test(c));
      if (bad) return { inputs: null, error: `"${bad}" isn't a community name. Use letters, numbers and _ only (2 to 21 of them).` };
      if (communities.length > 12) return { inputs: null, error: "Pick 12 communities at most." };
      if (d.dueDate && !DATE_RE.test(d.dueDate)) return { inputs: null, error: "Pick a real date for the posts, or leave it empty for launch day." };
      out.subreddit = { communities, dueDate: d.dueDate || null };
    } else if (kind === "ambassador") {
      const ambassadors = [];
      for (const l of lines(d.ambassadors)) {
        const [name = "", ref = ""] = l.split(",").map((x) => x.trim());
        if (!name) continue;
        if (name.length > 80) return { inputs: null, error: `"${name.slice(0, 20)}…" is too long for a name.` };
        if (ref && !REFERRAL_REF_RE.test(ref)) return { inputs: null, error: `The link code "${ref}" can only use letters, numbers, - and _.` };
        ambassadors.push({ name, ref: ref || null });
      }
      if (ambassadors.length > 200) return { inputs: null, error: "That's more than 200 ambassadors. Split them up." };
      if (d.reward.length > 400) return { inputs: null, error: "Keep what ambassadors get under 400 characters." };
      out.ambassador = { ambassadors, reward: orNull(d.reward) };
    } else if (kind === "press") {
      const targets = [];
      for (const t of d.targets) {
        if (!t.outlet.trim()) continue;
        const email = t.email.trim();
        if (email && !EMAIL_RE.test(email)) return { inputs: null, error: `Check the email for ${t.outlet.trim()}.` };
        targets.push({ outlet: t.outlet.trim().slice(0, 120), kind: t.kind, contactName: orNull(t.contactName.slice(0, 80)), email: email || null });
      }
      if (targets.length > 40) return { inputs: null, error: "Pick 40 places at most." };
      out.press = { targets };
    } else if (kind === "creator") {
      if (d.offer.length > 400) return { inputs: null, error: "Keep what you offer creators under 400 characters." };
      out.creator = { offer: orNull(d.offer) };
    } else if (kind === "reply_bank") {
      const extraQuestions = lines(d.extraQuestions).map((q) => q.slice(0, 300));
      if (extraQuestions.length > 30) return { inputs: null, error: "Add 30 questions at most." };
      out.reply_bank = { extraQuestions };
    }
  }
  return { inputs: out, error: null };
}

/** Kinds that take something typed in before writing. */
export const TAKES_INPUT: ReadonlySet<KitKind> = new Set(["subreddit", "ambassador", "press", "creator", "reply_bank"]);

export const OUTLET_TYPES = PRESS_OUTLET_TYPES;

/** "Writing…" and friends (§2.3 card status words). */
export const KIT_STATUS_LABEL = {
  missing: "Not written yet",
  planned: "Waiting to start",
  generating: "Writing…",
  ready: "Ready",
  needs_you: "Needs you",
  failed: "Didn't finish",
} as const;
export type KitStatusKey = keyof typeof KIT_STATUS_LABEL;

export const redditRulesUrl = (sub: string) => `https://www.reddit.com/r/${sub}/about/rules`;

/** Case-insensitive search over a reply bank: every word must appear in the question or the reply. */
export function searchReplies<T extends { trigger: string; reply: string }>(replies: readonly T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...replies];
  return replies.filter((r) => {
    const hay = `${r.trigger}\n${r.reply}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A kind is "not ready" for Write all when it was never written or didn't finish (kits with edits are left alone). */
export const writeAllKinds = (cards: readonly { kind: KitKind; status: KitStatusKey }[]) =>
  cards.filter((c) => c.status === "missing" || c.status === "failed").map((c) => c.kind);

/** One line per part, under its name. */
export const KIND_BLURB: Record<KitKind, string> = {
  subreddit: "One post per college community, checked against their rules. You post each one yourself.",
  ambassador: "A pitch, messages to send, caption examples with #ad and a personal link for each ambassador.",
  press: "A fact sheet, screenshots and 10 short pitches to student newsletters, papers and podcasts.",
  creator: "What to show, what to avoid, the #ad rules and messages you can send creators yourself.",
  reply_bank: "Answers to the questions people ask on launch day, ready to copy.",
  ads_export: "3 ad ideas with text for each platform, as files you upload yourself. The app spends nothing.",
};

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** "6 drafts", "24 replies"… from a stored body (shape-tolerant: a half-written body gives null). */
export function kitSummary(kind: KitKind, body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  switch (kind) {
    case "subreddit":
      return len(body.drafts) ? n(len(body.drafts), "draft") : null;
    case "ambassador":
      return len(body.templates) ? `${n(len(body.templates), "message")} · ${n(len(body.links), "personal link")}` : null;
    case "press":
      return len(body.pitches) ? `${n(len(body.pitches), "pitch", "pitches")} · ${n(len(body.facts), "fact")}` : null;
    case "creator":
      return len(body.dmTemplates) ? n(len(body.dmTemplates), "message") : null;
    case "reply_bank":
      return len(body.replies) ? n(len(body.replies), "reply", "replies") : null;
    case "ads_export": {
      const platforms = body.platforms && typeof body.platforms === "object" ? Object.values(body.platforms as Record<string, { skipped?: unknown }>) : [];
      const used = platforms.filter((p) => p && !p.skipped).length;
      return len(body.concepts) ? `${n(len(body.concepts), "idea")} · ${n(used, "platform")}` : null;
    }
  }
}

/** "2027-01-19" → "Tue, Jan 19, 2027" (a calendar date, so no time zone shift). */
export function launchDayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
}
