// Plain-English names for post states and platforms (§2.6). Shared by Queue and Today.

export const STATE_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Needs approval",
  approved: "Approved",
  queued: "Scheduled",
  preparing: "Getting ready",
  submitting: "Sending",
  submitted: "Sent, waiting for the platform",
  unknown: "Checking it went out",
  awaiting_user: "Finish in TikTok",
  published: "Posted",
  failed: "Didn't go out",
  missed: "Missed its slot",
  paused: "Paused",
  canceled: "Canceled",
};

export const STATE_TONE: Record<string, string> = {
  draft: "border-zinc-700 text-zinc-400",
  pending_approval: "border-amber-700/70 text-amber-200",
  approved: "border-sky-800 text-sky-200",
  queued: "border-sky-800 text-sky-200",
  preparing: "border-sky-800 text-sky-200",
  submitting: "border-sky-800 text-sky-200",
  submitted: "border-sky-800 text-sky-200",
  unknown: "border-amber-700/70 text-amber-200",
  awaiting_user: "border-amber-700/70 text-amber-200",
  published: "border-emerald-800 text-emerald-200",
  failed: "border-red-800 text-red-200",
  missed: "border-red-800 text-red-200",
  paused: "border-zinc-600 text-zinc-300",
  canceled: "border-zinc-800 text-zinc-500 line-through",
};

export const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  threads: "Threads",
  x: "X",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
  facebook: "Facebook",
  pinterest: "Pinterest",
  reddit: "Reddit",
  hackernews: "Hacker News",
  producthunt: "Product Hunt",
};

export const platformName = (p: string) => PLATFORM_LABEL[p] ?? p;
export const stateName = (s: string) => STATE_LABEL[s] ?? s;

/** Posts that can still be dragged to another day. */
export const MOVABLE_STATES = new Set(["draft", "pending_approval", "approved", "queued", "paused", "missed"]);
/** Nothing was sent yet: cancel is allowed. */
export const CANCELABLE_STATES = new Set(["draft", "pending_approval", "approved", "queued", "missed", "paused"]);
