import { z } from "zod";

// ── Email broadcasts (§5.4 Email "LC", §4.3 email_broadcasts, §8 email law row) ──

/** The one link token an email may use; it becomes the tracking link at render time. */
export const BROADCAST_LINK_TOKEN = "{{link:landing}}";

/**
 * copy.email output (§5.0 model-facing: every field required, no length or pattern keywords).
 * The footer (who's sending, postal address, why you get this, unsubscribe) is added by the
 * renderer, never written by the model.
 */
export const BroadcastDraftModel = z.object({
  subject: z.string(),
  /** The grey line inboxes show after the subject. */
  preheader: z.string(),
  /** Plain paragraphs in order. Links only as {{link:landing}}. No HTML, no greeting placeholders. */
  paragraphs: z.array(z.string()),
  /** Public fact refs (C1…) backing every number, price, superlative or quote. */
  claimRefs: z.array(z.string()),
});
export type BroadcastDraftModel = z.infer<typeof BroadcastDraftModel>;

export const BROADCAST_SUBJECT_MAX = 150;
export const BROADCAST_PREHEADER_MAX = 200;
export const BROADCAST_MAX_PARAGRAPHS = 12;

/** The body the editor works on. Stored in email_broadcasts.body as paragraphs joined by a blank line. */
export const BroadcastBody = z.object({
  subject: z.string().max(BROADCAST_SUBJECT_MAX),
  preheader: z.string().max(BROADCAST_PREHEADER_MAX).nullable(),
  paragraphs: z.array(z.string().min(1)).max(BROADCAST_MAX_PARAGRAPHS),
  claimRefs: z.array(z.string()),
});
export type BroadcastBody = z.infer<typeof BroadcastBody>;

/** Paragraphs ↔ the stored body text. Blank lines separate paragraphs; single newlines stay inside one. */
export function broadcastParagraphs(bodyText: string): string[] {
  return bodyText
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function broadcastBodyText(paragraphs: readonly string[]): string {
  return paragraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** What the editor may change. An edit after approval sends it back for approval (§4.3). */
export const BroadcastPatch = z
  .object({
    name: z.string().min(1).max(120),
    subject: z.string().max(BROADCAST_SUBJECT_MAX),
    preheader: z.string().max(BROADCAST_PREHEADER_MAX).nullable(),
    /** Paragraphs separated by a blank line. */
    body: z.string().max(20_000),
    claimRefs: z.array(z.string()),
    audienceId: z.string().min(1).nullable(),
    audienceLabel: z.string().nullable(),
    /** ISO 8601 with offset; null = not picked yet. */
    scheduledAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .partial();
export type BroadcastPatch = z.infer<typeof BroadcastPatch>;

/**
 * Sender identity for a product (products.email_settings). CAN-SPAM needs a real sender and postal
 * address; consentSource answers "Where did these contacts come from?"; euConsentAck is the
 * "EU contacts only with consent" tick (§5.4).
 */
export const BroadcastSettings = z.object({
  fromName: z.string().trim().min(1).max(80),
  fromEmail: z.email(),
  replyTo: z.email().optional(),
  postalAddress: z.string().trim().min(8).max(300),
  audienceId: z.string().min(1).optional(),
  audienceLabel: z.string().max(120).optional(),
  consentSource: z.string().trim().min(3).max(300).optional(),
  euConsentAck: z.boolean().optional(),
});
export type BroadcastSettings = z.infer<typeof BroadcastSettings>;

export const EMAIL_ISSUE_CODES = [
  "empty_subject",
  "empty_body",
  "missing_unsubscribe",
  "missing_postal_address",
  "missing_sender",
  "bad_reply_to",
  "missing_audience",
  "missing_consent_source",
  "eu_consent_unconfirmed",
  "missing_schedule",
  "schedule_in_past",
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
  "no_website",
  "jargon",
  "spam_rate",
  "raw_html",
] as const;
export type EmailIssueCode = (typeof EMAIL_ISSUE_CODES)[number];

/** Same shape as email_broadcasts.issues: plain sentences the editor shows. */
export const EmailIssue = z.object({
  code: z.enum(EMAIL_ISSUE_CODES),
  message: z.string(),
  severity: z.enum(["block", "warn"]),
});
export type EmailIssue = z.infer<typeof EmailIssue>;
