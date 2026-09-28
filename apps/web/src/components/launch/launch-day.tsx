import Link from "next/link";
import type { LaunchCountdown, LaunchDayNumbers, LaunchDayPost, LaunchDayView } from "@mkt/contracts";
import { localTime, plainDay } from "@mkt/core/publishing";
import { platformName, stateName } from "@/components/publishing/labels";
import { TaskRow } from "./plan-checklist";

// Launch-day view (§2.3 Launch): countdown, the gate verdict, today's posts with their live links
// (the comment deep link is the platform post URL), live numbers and the reply bank. Shown first
// on launch day, and as a preview lower down the page before it.

export function countdownText(c: LaunchCountdown): string {
  if (c.isLaunchDay) return "It's launch day";
  if (c.isPast) return `Launched ${-c.daysToLaunch} day${c.daysToLaunch === -1 ? "" : "s"} ago`;
  return `${c.daysToLaunch} day${c.daysToLaunch === 1 ? "" : "s"} to launch`;
}

const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));

function Numbers({ n, label }: { n: LaunchDayNumbers; label: string }) {
  const cells: [string, number | null][] = [
    ["Posts out", n.postsPublished],
    ["Views", n.views],
    ["Comments", n.comments],
    ["Link taps", n.linkClicks],
    ["Visits", n.visits],
    ["Signups", n.signups],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-zinc-500">{label}</p>
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {cells.map(([k, v]) => (
          <div key={k} className="rounded-md border border-zinc-800 px-3 py-2">
            <dt className="text-xs text-zinc-500">{k}</dt>
            <dd className="text-lg font-semibold tabular-nums">{fmt(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PostLine({ p, tz }: { p: LaunchDayPost; tz: string }) {
  const at = new Date(p.publishedAt ?? p.scheduledAt);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
      <span>
        <span className="font-medium">{platformName(p.platform)}</span>
        <span className="text-zinc-500">
          {" "}
          · {localTime(at, tz)} · {stateName(p.state)}
        </span>
      </span>
      {p.platformUrl ? (
        <a href={p.platformUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-zinc-200 underline underline-offset-2 hover:text-white">
          Open the post and answer comments
        </a>
      ) : (
        <span className="text-xs text-zinc-500">{p.state === "published" ? "Link not back from the platform yet" : "Not out yet"}</span>
      )}
    </li>
  );
}

export function LaunchDay({
  slug,
  view,
  tz,
  block,
  prominent,
}: {
  slug: string;
  view: LaunchDayView;
  tz: string;
  /** launchDayVerdict().block on launch day; null = posts go out. */
  block: string | null;
  prominent: boolean;
}) {
  const c = view.countdown;
  const passed = view.gates.gates.filter((g) => g.passed).length;
  const total = view.gates.gates.length;
  const replyHref = `/p/${encodeURIComponent(slug)}/launch/kits/reply_bank`;
  const replyReady = view.replyBank?.status === "ready";

  return (
    <section
      id="launch-day"
      className={`flex flex-col gap-5 rounded-lg border p-5 ${prominent ? "border-zinc-500 bg-zinc-900/60" : "border-zinc-800"}`}
      aria-label="Launch day"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">{prominent ? "Launch day" : "Launch day preview"}</p>
          <h2 className={prominent ? "text-2xl font-semibold" : "text-lg font-semibold"}>{countdownText(c)}</h2>
          <p className="text-sm text-zinc-400">Launch day is {plainDay(c.launchDate)}.</p>
        </div>
        <Link href={replyHref} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500">
          {replyReady ? "Open the reply bank" : view.replyBank ? "Reply bank (not ready yet)" : "Reply bank"}
        </Link>
      </div>

      {c.isLaunchDay ? (
        block ? (
          <div role="alert" className="rounded-md border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            <p className="font-medium">Posts are on hold.</p>
            <p>{block}</p>
          </div>
        ) : (
          <div className="rounded-md border border-emerald-800 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">
            Every check passed. Today&apos;s posts go out on schedule.
          </div>
        )
      ) : (
        <div className={`rounded-md border px-4 py-3 text-sm ${view.gates.allPassed ? "border-emerald-800 text-emerald-200" : "border-zinc-700 text-zinc-300"}`}>
          {view.gates.allPassed
            ? "Every launch-day check has passed. If they still pass on launch day, posts go out on schedule."
            : `On launch day, posts wait until every check passes. Right now ${passed} of ${total} ${total === 1 ? "has" : "have"} passed.`}
        </div>
      )}

      {view.todayTasks.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-300">{c.isLaunchDay ? "To do today" : "Due today or late"}</h3>
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-surface">
            {view.todayTasks.map((t) => (
              <TaskRow key={t.id} slug={slug} task={t} today={c.today} />
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-zinc-300">Today&apos;s posts</h3>
        {view.publishedToday.length + view.nextPostsToday.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing is set to go out today.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-surface">
            {view.publishedToday.map((p) => (
              <PostLine key={p.postId} p={p} tz={tz} />
            ))}
            {view.nextPostsToday.map((p) => (
              <PostLine key={p.postId} p={p} tz={tz} />
            ))}
          </ul>
        )}
        {view.publishedToday.length > 0 && <p className="text-xs text-zinc-500">Check comments in the morning, at lunch and at night. Copy answers from the reply bank.</p>}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-300">Live numbers</h3>
        <Numbers n={view.today} label={`Today, ${plainDay(view.today.day)}`} />
        <Numbers n={view.yesterday} label={`Yesterday, ${plainDay(view.yesterday.day)}`} />
        <p className="text-xs text-zinc-500">A dash means the platform or your site hasn&apos;t reported it yet. Numbers update through the day.</p>
      </div>
    </section>
  );
}
