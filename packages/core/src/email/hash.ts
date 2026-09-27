import { createHash } from "node:crypto";
import { canonicalJson } from "../publishing/hash.ts";

/** Suppression key (§5.4): sha256 of the trimmed, lower-cased address. The address itself is never stored. */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export interface BroadcastHashInput {
  subject: string;
  html: string;
  text: string;
  audienceId: string;
  scheduledAt: Date;
  /** "Name <email>" as sent. */
  from: string;
  replyTo: string | null;
}

/** approvals.content_hash for a broadcast (D9): everything Resend receives. Re-checked by email.submit. */
export function broadcastHash(i: BroadcastHashInput): string {
  const body = canonicalJson({
    v: 1,
    subject: i.subject,
    html: i.html,
    text: i.text,
    audienceId: i.audienceId,
    scheduledAt: i.scheduledAt.toISOString(),
    from: i.from,
    replyTo: i.replyTo,
  });
  return createHash("sha256").update(body).digest("hex");
}
