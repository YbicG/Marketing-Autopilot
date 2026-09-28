import Link from "next/link";
import { redirect } from "next/navigation";
import { listRuns } from "@mkt/core/runs";
import { getWorkspace } from "@mkt/core/tenancy";
import { AppShell } from "@/components/shell/app-shell";
import { NeedsYouGrid, needsYouCards } from "@/components/shell/needs-you-cards";
import { ProjectCard } from "@/components/shell/project-card";
import { getDb } from "@/lib/db";
import { loadProjects, loadReconnects } from "@/lib/projects";
import { requireWorkspace } from "@/lib/session";
import { DropZone } from "./drop-zone";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  completed: "Done",
  failed: "Failed",
};

const KIND_LABEL: Record<string, string> = {
  m0_summary: "Quick read",
  ingest: "Reading your product",
  strategy: "Picking angles",
  dna_regenerate: "Rewriting profile",
};

type Run = Awaited<ReturnType<typeof listRuns>>[number];

function runTitle(r: Run): string {
  const input = r.input as { url?: unknown; links?: unknown; slug?: unknown };
  if (typeof input.url === "string") return input.url;
  if (Array.isArray(input.links) && typeof input.links[0] === "string") return input.links.join(", ");
  if (typeof input.slug === "string") return input.slug;
  return KIND_LABEL[r.kind] ?? "Run";
}

function greeting(now: Date, tz: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now)) % 24;
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** Home (Studio): who needs you, every project at a glance, and the box to start the next one. */
export default async function Home() {
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  if (!ws.onboardedAt) redirect("/welcome");
  const [runs, projects, reconnects] = await Promise.all([listRuns(db, s.workspaceId, 6), loadProjects(s.workspaceId), loadReconnects(s.workspaceId)]);
  const cards = needsYouCards(projects, reconnects);
  const posting = projects.filter((p) => p.stage >= 4).length;
  const firstName = s.name.trim().split(/\s+/)[0] || "there";

  const summary =
    projects.length === 0
      ? "Nothing here yet. Paste a link below and we'll read your product."
      : [
          `${projects.length} project${projects.length === 1 ? "" : "s"}`,
          posting > 0 ? `${posting} posting` : null,
          cards.length > 0 ? `${cards.length} thing${cards.length === 1 ? "" : "s"} need${cards.length === 1 ? "s" : ""} you` : "nothing needs you",
        ]
          .filter(Boolean)
          .join(" · ");

  const newProject = (
    <section id="new" className="scroll-mt-8 rounded-2xl border border-dashed border-zinc-700 p-6">
      <h2 className="font-serif text-3xl tracking-tight">{projects.length ? "What are we marketing next?" : "What are we marketing?"}</h2>
      <p className="mb-5 mt-1 text-sm text-muted">A website, a GitHub repo, an app store link or a folder of screenshots. We read it and come back with a plan.</p>
      <DropZone />
    </section>
  );

  return (
    <AppShell workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} userName={s.name}>
      <main className="flex max-w-6xl flex-col gap-12 px-4 py-10 md:px-10">
        <header>
          <h1 className="font-serif text-4xl tracking-tight text-balance md:text-5xl">
            {greeting(new Date(), ws.timezone)}, <span className="italic text-accent">{firstName}</span>
          </h1>
          <p className="mt-2 text-muted">{summary}</p>
        </header>

        {cards.length > 0 && (
          <section className="flex flex-col gap-4" aria-labelledby="needs-you">
            <div className="flex items-baseline justify-between">
              <h2 id="needs-you" className="font-serif text-2xl">
                Needs you
              </h2>
              {cards.length > 3 && (
                <Link href="/needs-you" className="text-sm text-muted hover:text-ink">
                  See all {cards.length}
                </Link>
              )}
            </div>
            <NeedsYouGrid cards={cards.slice(0, 3)} />
          </section>
        )}

        {projects.length > 0 ? (
          <section className="flex flex-col gap-4" aria-labelledby="projects">
            <h2 id="projects" className="font-serif text-2xl">
              Projects
            </h2>
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {projects.map((p) => (
                <ProjectCard key={p.id} p={p} tz={ws.timezone} />
              ))}
            </div>
            {newProject}
          </section>
        ) : (
          newProject
        )}

        {runs.length > 0 && (
          <section className="flex flex-col gap-3" aria-labelledby="recent">
            <h2 id="recent" className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">
              Recent work
            </h2>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {runs.map((r) => {
                const slug = typeof r.input.slug === "string" ? r.input.slug : null;
                return (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-raised/60">
                    <Link href={`/runs/${r.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{runTitle(r)}</span>
                      <span className="text-xs text-faint">{KIND_LABEL[r.kind] ?? r.kind}</span>
                    </Link>
                    {slug && r.status === "completed" && (
                      <Link href={`/p/${slug}/plan`} className="shrink-0 text-sm text-accent hover:underline">
                        Your plan
                      </Link>
                    )}
                    <span className={`shrink-0 text-xs ${r.status === "failed" ? "text-red-300" : r.status === "running" ? "text-warn" : "text-faint"}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </AppShell>
  );
}
