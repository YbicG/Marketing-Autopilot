import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { env } from "@mkt/core/config";
import { productBySlug } from "@mkt/core/ingest";
import { storage } from "@mkt/core/media";
import { approvalCounts, assistedCards, dayBounds, localDay, localTime, queueView, yesterdayNumbers, addDays, type YesterdayNumbers } from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { ProjectTabs } from "@/components/project-tabs";
import { CopyOpenList } from "@/components/publishing/copy-open";
import { NeedsYouList } from "@/components/publishing/needs-you";
import { PauseControls } from "@/components/publishing/pause-controls";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../header";

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
  if (!backup) return { text: "Server: running · no backup found yet", ok: false };
  const ageH = (now.getTime() - backup.getTime()) / 3_600_000;
  const sameDay = localDay(backup, tz) === localDay(now, tz);
  const when = sameDay
    ? localTime(backup, tz)
    : `${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(backup)} ${localTime(backup, tz)}`;
  if (ageH > 36) return { text: `Server: running · last backup ${when}, more than a day ago. Check the backup job on the server.`, ok: false };
  return { text: `Server: healthy · last backup ${when}`, ok: true };
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
        <div key={k} className="rounded-md border border-zinc-800 px-3 py-2">
          <dt className="text-xs text-zinc-500">{k}</dt>
          <dd className="text-lg font-semibold tabular-nums">{fmt(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Today (§2.2): approvals waiting, Copy & open due, Needs you, yesterday's numbers, next post, server health. */
export default async function TodayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();

  const tz = ws.timezone;
  const now = new Date();
  const endOfToday = dayBounds(localDay(now, tz), tz).to;
  const [qv, counts, tasks, yesterday, backup] = await Promise.all([
    queueView(db, s.workspaceId, { from: now, to: now, productId: product.id, now }),
    approvalCounts(db, s.workspaceId, { productId: product.id, now }),
    assistedCards(db, s.workspaceId, { productId: product.id, dueBy: endOfToday, now }),
    yesterdayNumbers(db, s.workspaceId, product.id, now),
    lastBackup(),
  ]);
  const health = healthLine(backup, now, tz);
  const status = qv.statusLine.charAt(0).toLowerCase() + qv.statusLine.slice(1);
  const yesterdayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    new Date(`${addDays(localDay(now, tz), -1)}T12:00:00Z`),
  );

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={product.slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-500">{product.name}</p>
            <h1 className="text-2xl font-semibold">Today</h1>
            <p className="text-sm text-zinc-400">Posting from your server · {status}</p>
            <p className={`text-xs ${health.ok ? "text-zinc-500" : "text-amber-300"}`}>{health.text}</p>
          </div>
          <PauseControls slug={product.slug} pausedCount={counts.paused} />
        </div>

        <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 p-4" aria-label="Approvals">
          <div>
            <h2 className="font-semibold">
              {counts.waiting === 0 ? "Nothing waiting for approval" : `${counts.waiting} post${counts.waiting === 1 ? "" : "s"} waiting for your approval`}
            </h2>
            <p className="text-sm text-zinc-500">Nothing goes out until you approve it.</p>
          </div>
          {counts.waiting > 0 && (
            <Link href={`/p/${product.slug}/queue`} className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900">
              Review in Queue
            </Link>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Needs you">
          <h2 className="text-lg font-semibold">Needs you</h2>
          <NeedsYouList items={qv.needsYou} empty="Nothing needs you right now." />
        </section>

        {tasks.length > 0 && (
          <section className="flex flex-col gap-3" aria-label="Post these yourself">
            <div>
              <h2 className="text-lg font-semibold">Post these yourself today</h2>
              <p className="text-sm text-zinc-500">These communities don&apos;t allow apps to post. We wrote the text; you post it.</p>
            </div>
            <CopyOpenList tasks={tasks} />
          </section>
        )}

        <section className="flex flex-col gap-2" aria-label="Yesterday">
          <h2 className="text-lg font-semibold">{yesterdayLabel}&apos;s numbers</h2>
          {yesterday ? (
            <>
              <Numbers y={yesterday} />
              <p className="text-xs text-zinc-500">Latest counts for posts that went out {yesterdayLabel}. A dash means the platform doesn&apos;t report it yet.</p>
            </>
          ) : (
            <p className="text-sm text-zinc-500">Nothing went out {yesterdayLabel}, so there are no numbers yet.</p>
          )}
        </section>

        <section className="flex flex-col gap-1" aria-label="Next post">
          <h2 className="text-lg font-semibold">Next post</h2>
          <p className="text-sm text-zinc-300">
            {qv.statusLine}.{" "}
            <Link href={`/p/${product.slug}/queue`} className="underline underline-offset-2">
              Open the Queue
            </Link>
          </p>
        </section>
      </main>
    </>
  );
}
