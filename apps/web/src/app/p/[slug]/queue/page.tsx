import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { productBySlug } from "@mkt/core/ingest";
import { addDays, approvalCounts, assistedCards, dayBounds, localDay, mondayOf, queueView, shortSlot } from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { ProjectTabs } from "@/components/project-tabs";
import { BulkApprove } from "@/components/publishing/bulk-approve";
import { CopyOpenList } from "@/components/publishing/copy-open";
import { NeedsYouList } from "@/components/publishing/needs-you";
import { PauseControls } from "@/components/publishing/pause-controls";
import type { QueueChip } from "@/components/publishing/types";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../header";
import { QueueBoard, type BoardDay } from "./queue-board";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
  const mon = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(date);
  return d === 1 ? `${wd} ${mon} ${d}` : `${wd} ${d}`;
}

/** Queue (§2.3): week and month views, drag-to-reschedule, bulk approvals, Pause all posting, Needs you. */
export default async function QueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();

  const tz = ws.timezone;
  const now = new Date();
  const today = localDay(now, tz);
  const view: "week" | "month" = sp.view === "month" ? "month" : "week";
  const start = typeof sp.start === "string" && DAY.test(sp.start) ? sp.start : today;

  let first: string;
  let count: number;
  let monthPrefix: string | null = null;
  let prev: string;
  let next: string;
  if (view === "week") {
    first = mondayOf(start);
    count = 7;
    prev = addDays(first, -7);
    next = addDays(first, 7);
  } else {
    monthPrefix = start.slice(0, 7);
    const monthStart = `${monthPrefix}-01`;
    first = mondayOf(monthStart);
    const nextMonth = addDays(`${monthPrefix}-28`, 7).slice(0, 7);
    const gridEnd = addDays(mondayOf(addDays(`${nextMonth}-01`, -1)), 6);
    count = Math.round((Date.parse(gridEnd) - Date.parse(first)) / 86_400_000) + 1;
    prev = addDays(monthStart, -1).slice(0, 7) + "-01";
    next = `${nextMonth}-01`;
  }
  const last = addDays(first, count - 1);
  const from = dayBounds(first, tz).from;
  const to = dayBounds(last, tz).to;

  const [qv, counts, tasks] = await Promise.all([
    queueView(db, s.workspaceId, { from, to, productId: product.id, now }),
    approvalCounts(db, s.workspaceId, { productId: product.id, days: 7, now }),
    assistedCards(db, s.workspaceId, { productId: product.id, now }),
  ]);

  const byDay = new Map(qv.days.map((d) => [d.day, d.posts]));
  const days: BoardDay[] = Array.from({ length: count }, (_, i) => {
    const day = addDays(first, i);
    const chips: QueueChip[] = (byDay.get(day) ?? []).map((p) => ({
      id: p.id,
      platform: p.platform,
      state: p.state,
      mode: p.mode,
      handle: p.handle,
      time: shortSlot(p.scheduledAt, tz).split(" ").slice(1).join(" "),
      conflicts: p.conflicts,
      lastError: p.lastError,
    }));
    return { day, label: dayLabel(day), isToday: day === today, isPast: day < today, inRange: monthPrefix ? day.startsWith(monthPrefix) : true, chips };
  });

  const rangeLabel =
    view === "week"
      ? `${dayLabel(first).replace(/^\w+ /, "")} – ${dayLabel(last).replace(/^\w+ /, "")}`
      : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${monthPrefix}-01T12:00:00Z`));
  const status = qv.statusLine.charAt(0).toLowerCase() + qv.statusLine.slice(1);
  const href = (v: string, st: string) => `/p/${product.slug}/queue?view=${v}&start=${st}`;
  const tab = (active: boolean) => `rounded-md px-3 py-1 text-sm ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`;

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={product.slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Queue</h1>
            <p className="text-sm text-zinc-400">Posting from your server · {status}</p>
          </div>
          <PauseControls slug={product.slug} pausedCount={counts.paused} />
        </div>

        <BulkApprove slug={product.slug} nextDays={counts.nextDays} finishedVideos={counts.finishedVideos} />

        {qv.needsYou.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="Needs you">
            <h2 className="text-lg font-semibold">Needs you</h2>
            <NeedsYouList items={qv.needsYou} />
          </section>
        )}

        <section className="flex flex-col gap-3" aria-label="Calendar">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Link href={href(view, prev)} className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:border-zinc-500" aria-label="Earlier">
                ←
              </Link>
              <Link href={href(view, today)} className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:border-zinc-500">
                Today
              </Link>
              <Link href={href(view, next)} className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:border-zinc-500" aria-label="Later">
                →
              </Link>
              <span className="text-sm text-zinc-300">{rangeLabel}</span>
            </div>
            <div className="flex gap-1">
              <Link href={href("week", start)} className={tab(view === "week")}>
                Week
              </Link>
              <Link href={href("month", start)} className={tab(view === "month")}>
                Month
              </Link>
            </div>
          </div>
          <QueueBoard days={days} view={view} />
        </section>

        {tasks.length > 0 && (
          <section className="flex flex-col gap-3" aria-label="Copy and open">
            <div>
              <h2 className="text-lg font-semibold">Post these yourself</h2>
              <p className="text-sm text-zinc-500">These communities don&apos;t allow apps to post. We wrote the text; you post it.</p>
            </div>
            <CopyOpenList tasks={tasks} />
          </section>
        )}
      </main>
    </>
  );
}
