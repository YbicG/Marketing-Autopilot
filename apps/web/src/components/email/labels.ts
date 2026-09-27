// Plain words for the broadcast machine (§4.3 email_broadcasts), shared by the list and the editor.

export type BroadcastStatus = "draft" | "pending_approval" | "approved" | "scheduled_at_resend" | "sent" | "canceled" | "failed";

export const STATUS_LABEL: Record<BroadcastStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for you",
  approved: "Approved",
  scheduled_at_resend: "Scheduled at Resend",
  sent: "Sent",
  canceled: "Canceled",
  failed: "Failed",
};

export const STATUS_TONE: Record<BroadcastStatus, string> = {
  draft: "border-zinc-700 text-zinc-300",
  pending_approval: "border-amber-800 text-amber-300",
  approved: "border-sky-800 text-sky-300",
  scheduled_at_resend: "border-sky-700 text-sky-200",
  sent: "border-emerald-800 text-emerald-300",
  canceled: "border-zinc-800 text-zinc-500",
  failed: "border-red-900 text-red-300",
};

/** "Tue, Jan 6, 10:00 AM" in the workspace's time zone. */
export function sendTime(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "New York" from "America/New_York". */
export const tzName = (tz: string) => (tz.split("/").pop() ?? tz).replaceAll("_", " ");
