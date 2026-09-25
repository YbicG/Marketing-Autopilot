import type { BoardStatus } from "@mkt/core/engine";

const TONE: Record<BoardStatus | "Open", string> = {
  Drafting: "border-sky-800 bg-sky-950/40 text-sky-300",
  Ready: "border-zinc-600 bg-zinc-800 text-zinc-100",
  "Needs you": "border-amber-700 bg-amber-950/40 text-amber-300",
  Approved: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  Scheduled: "border-violet-800 bg-violet-950/40 text-violet-300",
  Posted: "border-emerald-600 bg-emerald-900/40 text-emerald-200",
  Failed: "border-red-800 bg-red-950/40 text-red-300",
  Open: "border-dashed border-zinc-700 text-zinc-500",
};

export const DOT: Record<BoardStatus | "Open", string> = {
  Drafting: "bg-sky-500",
  Ready: "bg-zinc-200",
  "Needs you": "bg-amber-400",
  Approved: "bg-emerald-500",
  Scheduled: "bg-violet-400",
  Posted: "bg-emerald-300",
  Failed: "bg-red-500",
  Open: "border border-dashed border-zinc-500",
};

export function StatusChip({ status }: { status: BoardStatus | "Open" }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>{status}</span>;
}

/** Post states in plain words (§4.3), for the editor's post list. */
export const POST_STATE_LABEL: Record<string, string> = {
  draft: "Draft: a check needs fixing",
  pending_approval: "Waiting for your approval",
  approved: "Approved",
  queued: "Scheduled",
  preparing: "Getting ready to post",
  submitting: "Posting",
  submitted: "Posting",
  unknown: "Checking whether it posted",
  awaiting_user: "Needs you to finish it",
  published: "Posted",
  failed: "Failed",
  missed: "Missed its time",
  paused: "Paused",
  canceled: "Skipped",
};

export const PLATFORM_NAME: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube Shorts",
  threads: "Threads",
  x: "X",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
};

/** D18 provenance tier → the card's AI-label chip. */
export function AiLabelChip({ tier }: { tier: "A" | "B" | "C" }) {
  const label = tier === "A" ? "Real screens" : tier === "B" ? "AI label: voice" : "AI label: images";
  const tone = tier === "A" ? "text-zinc-500 border-zinc-800" : "text-fuchsia-300 border-fuchsia-900";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${tone}`} title={tier === "A" ? "Made from your screenshots and templates" : "Posted with the platform's AI label"}>
      {label}
    </span>
  );
}

export function IssueList({ issues }: { issues: { severity: "block" | "warn"; message: string }[] }) {
  if (!issues.length) return <p className="text-xs text-emerald-400">All checks pass.</p>;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {issues.map((i, k) => (
        <li key={k} className={i.severity === "block" ? "text-red-400" : "text-amber-300"}>
          {i.severity === "block" ? "Must fix: " : "Check: "}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function when(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) }).format(new Date(iso));
}
