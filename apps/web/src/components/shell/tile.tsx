import type { ProjectSummary } from "@mkt/core/publishing";

const TONES = [
  "bg-accent-soft text-accent",
  "bg-warn-soft text-warn",
  "bg-info-soft text-info",
  "bg-rose-soft text-rose",
  "bg-olive-soft text-olive",
];

function tone(slug: string): string {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
}

/** The letter tile that stands for a project everywhere (sidebar, cards, project header). */
export function ProjectTile({ slug, name, size = "sm" }: { slug: string; name: string; size?: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "size-12 rounded-xl text-2xl" : size === "md" ? "size-9 rounded-lg text-lg" : "size-6 rounded-md text-sm";
  return (
    <span aria-hidden className={`${dims} ${tone(slug)} flex shrink-0 items-center justify-center font-serif leading-none`}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export interface ProjectState {
  label: string;
  dot: string;
}

/** One plain status per project, used by the sidebar dot and the card pill. */
export function projectState(p: Pick<ProjectSummary, "status" | "stage" | "working" | "attention" | "waitingApproval">): ProjectState {
  if (p.status === "parked") return { label: "Parked", dot: "bg-zinc-600" };
  if (p.attention > 0) return { label: "Needs you", dot: "bg-warn" };
  if (p.working) return { label: "Working", dot: "bg-warn motion-safe:animate-pulse" };
  if (p.waitingApproval > 0) return { label: "Waiting on approval", dot: "bg-warn" };
  if (p.stage >= 4) return { label: p.stage >= 5 ? "Posting and learning" : "Posting", dot: "bg-accent" };
  if (p.stage >= 1) return { label: "Getting ready", dot: "bg-zinc-400" };
  return { label: "Not read yet", dot: "bg-zinc-600" };
}
