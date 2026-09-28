import Link from "next/link";
import { PROJECT_STAGES, shortSlot, type ProjectSummary } from "@mkt/core/publishing";
import { projectState, ProjectTile } from "./tile";

/** "Jan 19" from an ISO day, read as a calendar date (no time zone shift). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Five segments: done, current, not yet. */
export function StageBar({ stage }: { stage: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1" aria-hidden>
        {PROJECT_STAGES.map((s, i) => (
          <span key={s} className={`h-1 flex-1 rounded-full ${i < stage ? "bg-accent" : i === stage ? "bg-accent/35" : "bg-zinc-800"}`} />
        ))}
      </div>
      <p className="text-xs text-muted">
        {stage >= PROJECT_STAGES.length ? (
          "All five stages running"
        ) : (
          <>
            <span className="text-ink">{stage === 0 ? "Starting" : `${PROJECT_STAGES[stage - 1]}`}</span>
            {stage > 0 && <> · next: {PROJECT_STAGES[stage]}</>}
          </>
        )}
      </p>
    </div>
  );
}

export function ProjectCard({ p, tz }: { p: ProjectSummary; tz: string }) {
  const state = projectState(p);
  const stats: [string, string][] = [
    ["Next post", p.nextPostAt ? shortSlot(p.nextPostAt, tz) : "None yet"],
    ["Launch", p.launchDate ? shortDate(p.launchDate) : "Not set"],
    ["Next 7 days", `${p.postsThisWeek} post${p.postsThisWeek === 1 ? "" : "s"}`],
  ];
  return (
    <Link
      href={`/p/${p.slug}`}
      className="group flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-zinc-700 hover:bg-raised/60"
    >
      <div className="flex items-start gap-3">
        <ProjectTile slug={p.slug} name={p.name} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-2xl leading-tight">{p.name}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <span aria-hidden className={`size-1.5 rounded-full ${state.dot}`} />
            {state.label}
          </p>
        </div>
      </div>
      <StageBar stage={p.stage} />
      <dl className="grid grid-cols-3 gap-3 border-t border-line pt-4">
        {stats.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">{k}</dt>
            <dd className="mt-0.5 truncate text-sm tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}
