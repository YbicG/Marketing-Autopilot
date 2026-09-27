import { findJargon, type EmailIssue, type EmailIssueCode } from "@mkt/contracts";
import { LINK_TOKEN } from "../publishing/links.ts";
import { RESEND_UNSUBSCRIBE, type EmailSettingsLike } from "./render.ts";

// The email law row of §8 (CAN-SPAM / GDPR), pure. Every issue is a plain sentence the editor shows.

export interface EmailClaimInfo {
  ref: string;
  kind?: string;
  publicOk: boolean;
  status: "sourced" | "verified" | "rejected";
  expiresAt: Date | null;
}

export interface BroadcastCheckInput {
  subject: string;
  preheader: string | null;
  paragraphs: readonly string[];
  claimRefs: readonly string[];
  settings: EmailSettingsLike | null;
  audienceId: string | null;
  scheduledAt: Date | null;
  now: Date;
  /** Claims of the product's current profile, by ref. */
  claims: ReadonlyMap<string, EmailClaimInfo>;
  /** The rendered email; present at approve time, when the footer can be checked. */
  rendered?: { html: string; text: string } | null;
  /** The product's previous sent broadcast: webhook counts (§5.4 spam rate under 0.3%). */
  previous?: { delivered: number; complained: number } | null;
  /** True only when this really answers the reader's email (never for a broadcast). */
  isReply?: boolean;
}

/** Complaints per delivered email above this block the next broadcast (Gmail/Yahoo bulk-sender rule). */
export const SPAM_RATE_LIMIT = 0.003;

/** Subject words that pressure or mislead. Lower-case; matched as whole words/phrases. */
export const URGENCY_PHRASES = [
  "urgent",
  "act now",
  "last chance",
  "final notice",
  "final warning",
  "action required",
  "immediate action",
  "respond now",
  "limited time",
  "expires today",
  "ends tonight",
  "only today",
  "today only",
  "don't miss out",
  "dont miss out",
  "hurry",
  "account suspended",
  "you've won",
  "you have won",
  "winner",
  "free money",
  "100% free",
  "risk-free",
  "risk free",
  "guaranteed",
  "once in a lifetime",
] as const;

const FAKE_REPLY = /^\s*(re|fwd?|fw|aw|tr)\s*:/i;
const RAW_URL = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/i;
const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?>/i;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/** Years (1990–2099) are dates, not claims. */
const YEAR = /\b(19[9]\d|20\d\d)\b/g;
const NUMBERISH = /(\d+(\.\d+)?\s?%|\$\s?\d|\b\d{2,}\b|\b\d+x\b|#1\b|\bbest\b|\bfastest\b|\bcheapest\b)/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const URGENCY_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${URGENCY_PHRASES.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "iu");

/** Codes a copy.email repair can fix (the rest are settings or schedule, which only the user can fix). */
export const CONTENT_ISSUE_CODES: ReadonlySet<EmailIssueCode> = new Set<EmailIssueCode>([
  "empty_subject",
  "empty_body",
  "subject_fake_reply",
  "subject_urgency",
  "subject_number_without_source",
  "subject_too_long",
  "number_without_source",
  "unknown_fact",
  "internal_fact",
  "rejected_fact",
  "unverified_testimonial",
  "fact_expires",
  "raw_link",
  "unknown_link",
  "jargon",
  "raw_html",
]);

export const emailHasBlock = (issues: readonly EmailIssue[]) => issues.some((i) => i.severity === "block");

export function subjectIssues(subject: string, claimRefs: readonly string[], isReply = false): EmailIssue[] {
  const out: EmailIssue[] = [];
  const s = subject.trim();
  if (!s) return [{ code: "empty_subject", severity: "block", message: "Add a subject line." }];
  if (!isReply && FAKE_REPLY.test(s)) {
    out.push({ code: "subject_fake_reply", severity: "block", message: 'The subject starts with "Re:" or "Fwd:" but this isn\'t a reply. That misleads people, and the law says subjects must be truthful.' });
  }
  const urgent = URGENCY_RE.exec(s);
  if (urgent) out.push({ code: "subject_urgency", severity: "block", message: `"${urgent[1]}" in the subject pressures people or reads as spam. Say plainly what the email is about.` });
  if (/\d/.test(s.replace(YEAR, "")) && !claimRefs.length) {
    out.push({ code: "subject_number_without_source", severity: "block", message: "The subject has a number but no fact from your profile backs it. Remove it or attach the fact." });
  }
  if (s.length > 90) out.push({ code: "subject_too_long", severity: "warn", message: `The subject is ${s.length} characters; phones cut it off after about 60.` });
  return out;
}

export function emailClaimIssues(refs: readonly string[], claims: ReadonlyMap<string, EmailClaimInfo>, scheduledAt: Date | null): EmailIssue[] {
  const out: EmailIssue[] = [];
  for (const ref of new Set(refs)) {
    const c = claims.get(ref);
    if (!c) out.push({ code: "unknown_fact", severity: "block", message: `It leans on a fact we don't have (${ref}).` });
    else if (c.status === "rejected") out.push({ code: "rejected_fact", severity: "block", message: `It uses a fact you marked as wrong (${ref}).` });
    else if (!c.publicOk) out.push({ code: "internal_fact", severity: "block", message: `It uses a private fact that can't be said in public (${ref}).` });
    else if (c.kind === "testimonial" && c.status !== "verified") {
      out.push({ code: "unverified_testimonial", severity: "block", message: `It quotes a testimonial you haven't verified yet (${ref}).` });
    } else if (c.expiresAt && scheduledAt && c.expiresAt.getTime() < scheduledAt.getTime()) {
      out.push({ code: "fact_expires", severity: "block", message: `A fact it uses (${ref}) goes out of date before this is sent.` });
    }
  }
  return out;
}

export function validateBroadcast(i: BroadcastCheckInput): EmailIssue[] {
  const out: EmailIssue[] = [];
  const s = i.settings ?? {};
  const paras = i.paragraphs.map((p) => p.trim()).filter(Boolean);
  const body = paras.join("\n");

  out.push(...subjectIssues(i.subject, i.claimRefs, i.isReply));
  if (!paras.length) out.push({ code: "empty_body", severity: "block", message: "The email has no text yet." });

  const bare = [body, i.preheader ?? ""].join("\n").replace(new RegExp(LINK_TOKEN.source, "gi"), " ");
  if (RAW_URL.test(bare) || RAW_URL.test(i.subject)) {
    out.push({ code: "raw_link", severity: "block", message: "There's a web address typed in by hand. Use the website link instead, so it's tracked." });
  }
  for (const m of body.matchAll(new RegExp(LINK_TOKEN.source, "gi"))) {
    if ((m[1] ?? "").toLowerCase() !== "landing") {
      out.push({ code: "unknown_link", severity: "block", message: `Unknown link "${m[1]}". Only your website link can go in an email.` });
    }
  }
  if (HTML_TAG.test(body) || HTML_TAG.test(i.subject)) {
    out.push({ code: "raw_html", severity: "warn", message: "It has HTML tags; they'll show as plain text." });
  }
  out.push(...emailClaimIssues(i.claimRefs, i.claims, i.scheduledAt));
  if (!i.claimRefs.length && NUMBERISH.test(body.replace(YEAR, ""))) {
    out.push({ code: "number_without_source", severity: "warn", message: "It has a number or a strong claim with no fact attached. Check it's true." });
  }
  const jargon = findJargon([i.subject, i.preheader ?? "", body].join("\n"), "post");
  if (jargon.length) out.push({ code: "jargon", severity: "warn", message: `Marketing jargon: ${[...new Set(jargon.map((j) => j.term))].join(", ")}.` });

  // Sender identity, address, consent (CAN-SPAM / GDPR).
  if (!s.fromName?.trim() || !s.fromEmail || !EMAIL_RE.test(s.fromEmail.trim())) {
    out.push({ code: "missing_sender", severity: "block", message: "Add who it's from: a name and a from address on your sending domain." });
  }
  if (s.replyTo && !EMAIL_RE.test(s.replyTo.trim())) out.push({ code: "bad_reply_to", severity: "block", message: "The reply-to address doesn't look like an email address." });
  if (!s.postalAddress || s.postalAddress.trim().length < 8) {
    out.push({ code: "missing_postal_address", severity: "block", message: "Add a postal address. The law requires one in every marketing email (a PO box works)." });
  }
  if (!s.consentSource?.trim()) {
    out.push({ code: "missing_consent_source", severity: "block", message: "Where did these contacts come from? Say how they signed up (for example: they bought SyllaCal and agreed to product news)." });
  }
  if (s.euConsentAck !== true) {
    out.push({ code: "eu_consent_unconfirmed", severity: "warn", message: "Only email people in the EU or UK who agreed to hear from you. Tick the box in email settings once you've checked." });
  }
  if (!i.audienceId) out.push({ code: "missing_audience", severity: "block", message: "Pick who it goes to (your Resend list of past buyers)." });
  if (!i.scheduledAt) out.push({ code: "missing_schedule", severity: "block", message: "Pick when it goes out." });
  else if (i.scheduledAt.getTime() < i.now.getTime() - 60_000) out.push({ code: "schedule_in_past", severity: "block", message: "The send time has passed. Pick a new time." });

  if (i.rendered) {
    if (!i.rendered.html.includes(RESEND_UNSUBSCRIBE) || !i.rendered.text.includes(RESEND_UNSUBSCRIBE)) {
      out.push({ code: "missing_unsubscribe", severity: "block", message: "The email has no unsubscribe link." });
    }
    const postal = s.postalAddress?.trim();
    if (postal && !i.rendered.text.includes(postal.replace(/[\r\n]+/g, " "))) {
      out.push({ code: "missing_postal_address", severity: "block", message: "The postal address is missing from the email's footer." });
    }
  }

  if (i.previous) {
    const { delivered, complained } = i.previous;
    const rate = delivered > 0 ? complained / delivered : complained > 0 ? 1 : 0;
    if (rate > SPAM_RATE_LIMIT) {
      out.push({
        code: "spam_rate",
        severity: "block",
        message: `Your last email was marked as spam by ${complained} of ${delivered} people (${(rate * 100).toFixed(2)}%, the limit is 0.3%). Sending again now risks your domain being blocked. Clean the list first.`,
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.code}:${x.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
