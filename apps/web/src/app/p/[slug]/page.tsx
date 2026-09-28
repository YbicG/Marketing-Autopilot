import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { env } from "@mkt/core/config";
import { productBySlug } from "@mkt/core/ingest";
import { storage } from "@mkt/core/media";
import {
  addDays,
  approvalCounts,
  assistedCards,
  dayBounds,
  localDay,
  localTime,
  queueView,
  yesterdayNumbers,
  type QueuePost,
  type YesterdayNumbers,
} from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { CopyOpenList } from "@/components/publishing/copy-open";
import { PLATFORM_LABEL, STATE_LABEL } from "@/components/publishing/labels";
import { NeedsYouList } from "@/components/publishing/needs-you";
import { PauseControls } from "@/components/publishing/pause-controls";
import { StageBar } from "@/components/shell/project-card";
import { projectState } from "@/components/shell/tile";
import { getDb } from "@/lib/db";
import { loadProjects } from "@/lib/projects";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Newest object under backups/pg/, or null. Bounded so a slow bucket never holds up the page. */
async function lastBackup(): Promise<Date | null> {
  try {
    const list = storage(env()).list("backups/pg/");
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500));
    const objects = await Promise.race([list, timeout]);
    if (!objects?.length) return null;
    return objects.reduce((a, b) => (b.lastModified > a.lastModified ? b : a)).lastModified;
  } catch {
    return null;
  }
}

function healthLine(backup: Date | null, now: Date, tz: string): { text: string; ok: boolean } {
  if (!backup) return { text: "Server running · no backup found yet", ok: false };
  const ageH = (now.getTime() - backup.getTime()) / 3_600_000;
  const sameDay = localDay(backup, tz) === localDay(now, tz);
  const when = sameDay
    ? localTime(backup, tz)
    : `${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(backup)} ${localTime(backup, tz)}`;
  if (ageH > 36) return { text: `Server running · last backup ${when}, more than a day ago. Check the backup job on the server.`, ok: false };
  return { text: `Server healthy · last backup ${when}`, ok: true };
}

const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));

function Numbers({ y }: { y: YesterdayNumbers }) {
  const cells: [string, number | null][] = [
    ["Posts", y.posts],
    ["Views", y.views],
    ["Likes", y.likes],
    ["Comments", y.comments],
    ["Link taps", y.linkClicks],
    ["Signups", y.signups],
  ];
  return (
    <dl className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {cells.map(([k, v]) => (
        <div key={k} className="rounded-xl border border-line bg-surface px-3 py-3">
          <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">{k}</dt>
          <dd className="mt-1 font-serif text-3xl tabular-nums leading-none">{fmt(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

const CHIP_TONE: Record<string, string> = {
  pending_approval: "border-warn/40 bg-warn-soft/60",
  awaiting_user: "border-warn/40 bg-warn-soft/60",
  failed: "border-red-400/40 bg-red-950/30",
  missed: "border-red-400/40 bg-red-950/30",
  published: "border-accent/30 bg-accent-soft",
  paused: "border-zinc-700 bg-surface opacity-70",
  canceled: "border-zinc-800 bg-surface opacity-50 line-through",
};

/** The next seven days as columns of post chips. Read-only here; the Calendar is where you move things. */
function WeekStrip({ days, slug, tz }: { days: { day: string; posts: QueuePost[] }[]; slug: string; tz: string }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {days.map(({ day, posts }, i) => {
        const [y, m, d] = day.split("-").map(Number) as [number, number, number];
        const date = new Date(Date.UTC(y, m - 1, d));
        const wd = i === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
        return (
          <div key={day} className={`flex min-h-32 flex-col gap-1.5 rounded-xl border p-2 ${i === 0 ? "border-accent/40 bg-surface" : "border-line bg-surface/60"}`}>
            <p className="flex items-baseline justify-between px-0.5 text-xs">
              <span className={i === 0 ? "font-medium text-accent" : "text-muted"}>{wd}</span>
              <span className="tabular-nums text-faint">{d}</span>
            </p>
            {posts.map((p) => (
              <Link
                key={p.id}
                href={`/p/${slug}/queue?start=${day}`}
                title={STATE_LABEL[p.state] ?? p.state}
                className={`rounded-lg border px-2 py-1.5 text-xs hover:border-zinc-600 ${CHIP_TONE[p.state] ?? "border-line bg-raised"}`}
              >
                <span className="block tabular-nums text-faint">{localTime(p.scheduledAt, tz)}</span>
                <span className="block truncate text-ink">{PLATFORM_LABEL[p.platform] ?? p.platform}</span>
                <span className="sr-only">, {STATE_LABEL[p.state] ?? p.state}</span>
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Project overview (Studio): status, the coming week, what needs you, and yesterday's numbers. */
export default async function OverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();

  const tz = ws.timezone;
  const now = new Date();
  const today = localDay(now, tz);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  // One queue read covers the week strip; the status line and Needs you don't depend on the range.
  const [week, counts, tasks, yesterday, backup, projects] = await Promise.all([
    queueView(db, s.workspaceId, { from: dayBounds(today, tz).from, to: dayBounds(weekDays[6]!, tz).to, productId: product.id, now }),
    approvalCounts(db, s.workspaceId, { productId: product.id, now }),
    assistedCards(db, s.workspaceId, { productId: product.id, dueBy: dayBounds(today, tz).to, now }),
    yesterdayNumbers(db, s.workspaceId, product.id, now),
    lastBackup(),
    loadProjects(s.workspaceId),
  ]);
  const summary = projects.find((p) => p.id === product.id);
  const state = summary ? projectState(summary) : null;
  const health = healthLine(backup, now, tz);
  const byDay = new Map(week.days.map((d) => [d.day, d.posts]));
  const days = weekDays.map((day) => ({ day, posts: byDay.get(day) ?? [] }));
  const weekTotal = days.reduce((n, d) => n + d.posts.length, 0);
  const yesterdayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${addDays(today, -1)}T12:00:00Z`));

  return (
    <main className="flex max-w-6xl flex-col gap-10 px-4 py-10 md:px-10">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex max-w-2xl flex-col gap-3">
          {state && (
            <span className="flex items-center gap-1.5 self-start rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-muted">
              <span aria-hidden className={`size-1.5 rounded-full ${state.dot}`} />
              {state.label}
            </span>
          )}
          <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-balance md:text-5xl">
            {product.name}
            <span className="text-muted"> · {week.statusLine.charAt(0).toLowerCase() + week.statusLine.slice(1)}</span>
          </h1>
          {summary && (
            <div className="max-w-md">
              <StageBar stage={summary.stage} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/p/${product.slug}/plan`} className="inline-flex min-h-11 items-center rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500 md:min-h-9">
            Edit plan
          </Link>
          <Link href={`/p/${product.slug}/content`} className="inline-flex min-h-11 items-center rounded-lg bg-accent-strong px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-accent-hover md:min-h-9">
            Make more content
          </Link>
        </div>
      </header>

      {counts.waiting > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warn/25 bg-warn-soft/40 p-4" aria-label="Approvals">
          <div>
            <h2 className="font-medium">
              {counts.waiting} post{counts.waiting === 1 ? "" : "s"} waiting for your approval
            </h2>
            <p className="text-sm text-muted">Nothing goes out until you approve it.</p>
          </div>
          <Link href={`/p/${product.slug}/queue`} className="inline-flex min-h-11 items-center rounded-lg bg-warn px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-warn/90 md:min-h-9">
            Review in Calendar
          </Link>
        </section>
      )}

      <section className="flex flex-col gap-4" aria-labelledby="week">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="week" className="font-serif text-2xl">
            This week <span className="font-sans text-sm text-faint">· {weekTotal} post{weekTotal === 1 ? "" : "s"}</span>
          </h2>
          <div className="flex items-center gap-4">
            <PauseControls slug={product.slug} pausedCount={counts.paused} />
            <Link href={`/p/${product.slug}/queue`} className="inline-flex min-h-11 items-center text-sm text-accent hover:underline md:min-h-9">
              Open calendar
            </Link>
          </div>
        </div>
        <WeekStrip days={days} slug={product.slug} tz={tz} />
      </section>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="flex flex-col gap-3" aria-labelledby="needs">
          <h2 id="needs" className="font-serif text-2xl">
            Needs you
          </h2>
          <NeedsYouList items={week.needsYou} empty="Nothing needs you right now." />
        </section>

        {tasks.length > 0 && (
          <section className="flex flex-col gap-3" aria-labelledby="yourself">
            <div>
              <h2 id="yourself" className="font-serif text-2xl">
                Post these yourself today
              </h2>
              <p className="text-sm text-muted">These communities don&apos;t allow apps to post. We wrote the text; you post it.</p>
            </div>
            <CopyOpenList tasks={tasks} />
          </section>
        )}
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="numbers">
        <div className="flex items-baseline justify-between">
          <h2 id="numbers" className="font-serif text-2xl">
            {yesterdayLabel}&apos;s numbers
          </h2>
          <Link href={`/p/${product.slug}/results`} className="inline-flex min-h-11 items-center text-sm text-accent hover:underline md:min-h-9">
            All results
          </Link>
        </div>
        {yesterday ? (
          <>
            <Numbers y={yesterday} />
            <p className="text-xs text-faint">Latest counts for posts that went out {yesterdayLabel}. A dash means the platform doesn&apos;t report it yet.</p>
          </>
        ) : (
          <p className="text-sm text-muted">Nothing went out {yesterdayLabel}, so there are no numbers yet.</p>
        )}
      </section>

      <p className={`text-xs ${health.ok ? "text-faint" : "text-warn"}`}>{health.text}</p>
    </main>
  );
}
