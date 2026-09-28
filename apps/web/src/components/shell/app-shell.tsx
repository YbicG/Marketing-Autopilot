import Link from "next/link";
import type { ReactNode } from "react";
import { configuredPurposes, formatMonthlyRange, formatUsd, monthSpend, openAlerts, subscriptionSummary } from "@mkt/core/cost";
import type { ProjectSummary } from "@mkt/core/publishing";
import { BudgetToast } from "@/app/budget-toast";
import { getDb } from "@/lib/db";
import { loadProjects, loadReconnects } from "@/lib/projects";
import { Icon } from "./icons";
import { SidebarNav, type NavItem } from "./sidebar-nav";
import { projectState, ProjectTile } from "./tile";

export interface ShellProps {
  workspaceId: string;
  limitMicros: number;
  userName: string;
  /** Inside a project: the sidebar swaps to that project's sections. */
  projectSlug?: string;
  children: ReactNode;
}

/** How many things across every project are waiting on the user (the "Needs you" badge). */
export function needsYouTotal(projects: ProjectSummary[], reconnects: number): number {
  return reconnects + projects.reduce((n, p) => n + p.attention + p.waitingApproval, 0);
}

function projectNav(slug: string): NavItem[] {
  const p = (s: string) => `/p/${slug}${s ? `/${s}` : ""}`;
  return [
    { href: p(""), label: "Overview", icon: "overview", exact: true, also: [p("today")] },
    { href: p("queue"), label: "Calendar", icon: "calendar" },
    {
      href: p("content"),
      label: "Content",
      icon: "content",
      children: [
        { href: p("content"), label: "Posts & videos" },
        { href: p("email"), label: "Email" },
      ],
    },
    { href: p("plan"), label: "Plan & profile", icon: "plan" },
    { href: p("launch"), label: "Launch", icon: "launch" },
    { href: p("results"), label: "Results", icon: "results" },
    {
      href: p("assets"),
      label: "Library",
      icon: "library",
      children: [
        { href: p("assets"), label: "Screens & clips" },
        { href: p("capture"), label: "Demo recording" },
      ],
    },
  ];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * The Studio app frame: a warm sidebar with every project, the spend meter and settings, and the
 * page on the right. On phones the sidebar folds into a menu at the top.
 */
export async function AppShell({ workspaceId, limitMicros, userName, projectSlug, children }: ShellProps) {
  const db = getDb();
  const [projects, reconnects, m, alerts, configured] = await Promise.all([
    loadProjects(workspaceId),
    loadReconnects(workspaceId),
    monthSpend(db, workspaceId, limitMicros),
    openAlerts(db, workspaceId),
    configuredPurposes(db, workspaceId),
  ]);
  const used = m.spentMicros + m.reservedMicros;
  const pct = m.capMicros > 0 ? Math.min(100, Math.round((used / m.capMicros) * 100)) : 0;
  const bar = pct >= 100 ? "bg-red-400" : pct >= 80 ? "bg-warn" : "bg-accent";
  const subs = formatMonthlyRange(subscriptionSummary(configured));
  const alert = alerts[0]; // highest threshold first
  const current = projectSlug ? projects.find((p) => p.slug === projectSlug) : undefined;
  const needs = needsYouTotal(projects, reconnects);

  const body = (
    <div className="flex h-full flex-col gap-6 px-3 py-4">
      <Link href="/" className="flex items-center gap-2.5 px-1.5">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent-strong font-serif text-lg leading-none text-zinc-50">A</span>
        <span className="font-serif text-xl tracking-tight">Autopilot</span>
      </Link>

      {current ? (
        <>
          <div className="flex flex-col gap-3">
            <Link href="/" className="flex items-center gap-1.5 px-1.5 text-xs text-faint hover:text-ink">
              <Icon name="back" className="size-3.5" /> All projects
            </Link>
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
              <ProjectTile slug={current.slug} name={current.name} size="md" />
              <div className="min-w-0">
                <p className="truncate font-medium">{current.name}</p>
                <p className="flex items-center gap-1.5 text-xs text-muted">
                  <span className={`size-1.5 rounded-full ${projectState(current).dot}`} />
                  {projectState(current).label}
                </p>
              </div>
            </div>
          </div>
          <SidebarNav label="Project" items={projectNav(current.slug)} />
        </>
      ) : (
        <>
          <SidebarNav
            label="Main"
            items={[
              { href: "/", label: "Home", icon: "home", exact: true },
              { href: "/needs-you", label: "Needs you", icon: "bell", badge: needs },
              { href: "/settings/spending", label: "Spending", icon: "wallet" },
            ]}
          />
          <div className="flex flex-col gap-1">
            <p className="px-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Projects</p>
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/p/${p.slug}`}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-surface hover:text-ink"
              >
                <ProjectTile slug={p.slug} name={p.name} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span title={projectState(p).label} className={`size-1.5 rounded-full ${projectState(p).dot}`} />
              </Link>
            ))}
            <Link href="/#new" className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-faint hover:bg-surface hover:text-ink">
              <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-zinc-700">
                <Icon name="plus" className="size-3.5" />
              </span>
              New project
            </Link>
          </div>
        </>
      )}

      <div className="mt-auto flex flex-col gap-3">
        <Link href="/settings/spending" className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3 hover:border-zinc-700">
          <span className="flex items-baseline justify-between text-xs text-muted">
            <span>This month</span>
            <span className="tabular-nums">{pct}%</span>
          </span>
          <span className="text-sm">
            <span className="font-medium tabular-nums text-ink">{formatUsd(used)}</span>
            <span className="text-faint"> of {formatUsd(m.capMicros)}</span>
          </span>
          <span className="h-1 overflow-hidden rounded-full bg-zinc-800">
            <span className={`block h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="text-[11px] text-faint">Subscriptions {subs}</span>
        </Link>
        <div className="flex items-center gap-2.5 px-1.5">
          <span className="flex size-7 items-center justify-center rounded-full bg-raised text-xs font-medium text-ink">{initials(userName)}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{userName}</span>
          <Link href="/settings" aria-label="Settings" className="rounded-md p-1 text-faint hover:bg-surface hover:text-ink">
            <Icon name="gear" />
          </Link>
        </div>
      </div>
    </div>
  );

  return (
    <div className="md:flex">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 overflow-y-auto border-r border-line bg-rail md:block">{body}</aside>
      <details className="border-b border-line bg-rail md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3">
          <span className="font-serif text-xl">{current?.name ?? "Autopilot"}</span>
          <span className="flex items-center gap-2 text-sm text-muted">
            {needs > 0 && <span className="rounded-full bg-warn-soft px-1.5 text-xs text-warn">{needs}</span>}
            <Icon name="menu" className="size-5" />
          </span>
        </summary>
        {body}
      </details>
      <div className="min-w-0 flex-1">
        {alert && <BudgetToast thresholdPct={alert.thresholdPct} limitLabel={formatUsd(alert.capMicros).replace(/\.00$/, "")} />}
        {children}
      </div>
    </div>
  );
}
