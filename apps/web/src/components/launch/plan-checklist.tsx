import Link from "next/link";
import type { LaunchTaskGroup, LaunchTaskView } from "@mkt/contracts";
import { daysBetween } from "@mkt/core/launch";
import { plainDay } from "@mkt/core/publishing";
import { TaskActions } from "./plan-task-actions";

// The D30 checklist (§2.3 Launch): grouped by week, then by day (real date, campaign day and days
// to launch). Server component; the row buttons are the client TaskActions.

export const MODE_TONE: Record<string, string> = {
  auto: "border-sky-800 text-sky-300",
  assisted: "border-olive/40 text-olive",
  manual: "border-amber-700/70 text-amber-200",
  gate: "border-rose/40 text-rose",
};

const STATUS: Record<string, { label: string; tone: string }> = {
  todo: { label: "Not yet", tone: "text-zinc-500" },
  ready: { label: "Ready for you", tone: "text-zinc-100" },
  scheduled: { label: "On its way", tone: "text-sky-300" },
  done: { label: "Done", tone: "text-emerald-400" },
  skipped: { label: "Skipped", tone: "text-zinc-500" },
};

export function statusLabel(t: Pick<LaunchTaskView, "status" | "optional" | "mode">): { label: string; tone: string } {
  if (t.optional && t.status === "skipped") return { label: "Off", tone: "text-zinc-500" };
  if (t.mode === "gate" && t.status !== "done") return { label: "Not passed yet", tone: "text-rose" };
  if (t.mode === "gate") return { label: "Passed", tone: "text-emerald-400" };
  return STATUS[t.status] ?? { label: t.status, tone: "text-zinc-400" };
}

/** Where a row points (its content, kit, email, check or screen), or null. */
export function taskHref(slug: string, t: Pick<LaunchTaskView, "key" | "ref">): { href: string; label: string } | null {
  const base = `/p/${encodeURIComponent(slug)}`;
  const ref = t.ref ?? {};
  if (ref.kind === "kit" && ref.kitKind) return { href: `${base}/launch/kits/${ref.kitKind}`, label: "Open the kit" };
  if (ref.kind === "content_range") return { href: `${base}/content`, label: "Open the posts" };
  if (ref.kind === "broadcast_write" || ref.kind === "broadcast_approve" || ref.kind === "broadcast_send") {
    return { href: ref.broadcastId ? `${base}/email/${ref.broadcastId}` : `${base}/email`, label: "Open the email" };
  }
  if (ref.kind === "tracking_test" || ref.kind === "landing_audit") return { href: "#checks", label: "Go to the check" };
  if (ref.contentItemId) return { href: `${base}/content/post/${ref.contentItemId}`, label: "Open the post" };
  if (ref.assistedTaskId) return { href: base, label: "Open in Overview" };
  switch (t.key) {
    case "launch.subreddit_posts":
      return { href: `${base}/launch/kits/subreddit`, label: "Open the drafts" };
    case "launch.reply_bank":
    case "launch.watch_comments":
      return { href: `${base}/launch/kits/reply_bank`, label: "Open the reply bank" };
    case "send.ambassadors":
    case "after.thank_helpers":
      return { href: `${base}/launch/kits/ambassador`, label: "Open the kit" };
    case "send.press_pitches":
    case "after.press_follow_up":
      return { href: `${base}/launch/kits/press`, label: "Open the pitches" };
    case "send.creator_dms":
      return { href: `${base}/launch/kits/creator`, label: "Open the messages" };
    case "launch.numbers":
    case "after.day1_recap":
    case "after.week1_recap":
    case "after.week2_recap":
    case "after.final_recap":
      return { href: `${base}/results`, label: "Open Results" };
    case "xlinks.on":
    case "xlinks.off":
      return { href: "#x-links", label: "Set the dates" };
    default:
      return null;
  }
}

/** "You" / "Assisted" rows the person ticks. The email approval follows the email itself. */
export const isTickable = (t: Pick<LaunchTaskView, "mode" | "ref">) => (t.mode === "manual" || t.mode === "assisted") && t.ref?.kind !== "broadcast_approve";

function dayHeading(due: string, startDate: string, t: LaunchTaskView): string {
  const campaignDay = daysBetween(startDate, due) + 1;
  const parts = [plainDay(due)];
  if (campaignDay >= 1 && campaignDay <= 30) parts.push(`Day ${campaignDay}`);
  parts.push(t.dayLabel);
  return parts.join(" · ");
}

export function TaskRow({ slug, task, today }: { slug: string; task: LaunchTaskView; today: string }) {
  const s = statusLabel(task);
  const link = taskHref(slug, task);
  const off = task.optional && task.status === "skipped";
  const reasons = task.status === "done" || off ? [] : task.reasons;
  return (
    <li className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${off ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${MODE_TONE[task.mode] ?? ""}`}>{task.modeLabel}</span>
          <span className={`text-sm font-medium ${task.status === "done" ? "text-zinc-400 line-through decoration-zinc-600" : ""}`}>{task.title}</span>
          {task.optional && <span className="text-xs text-zinc-500">optional</span>}
        </div>
        {task.detail && <p className="text-xs text-zinc-500">{task.detail}</p>}
        {reasons.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {reasons.map((r) => (
              <li key={r} className="text-xs text-zinc-400">
                {r}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={s.tone}>{s.label}</span>
          {task.overdue && <span className="text-amber-300">Late: was due {task.dueDate < today ? plainDay(task.dueDate) : "today"}</span>}
          {link && (
            <Link href={link.href} className="inline-flex min-h-11 items-center text-zinc-300 underline underline-offset-2 hover:text-zinc-100 md:min-h-0">
              {link.label}
            </Link>
          )}
        </div>
      </div>
      {task.mode !== "gate" && (
        <TaskActions
          taskId={task.id}
          status={task.status}
          tickable={isTickable(task)}
          optional={task.optional}
          blocked={task.status === "todo" && task.blockedBy.length > 0}
        />
      )}
    </li>
  );
}

export function PlanChecklist({ slug, groups, startDate, today }: { slug: string; groups: LaunchTaskGroup[]; startDate: string; today: string }) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => {
        const byDay = new Map<string, LaunchTaskView[]>();
        for (const t of g.tasks) byDay.set(t.dueDate, [...(byDay.get(t.dueDate) ?? []), t]);
        const done = g.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
        return (
          <section key={g.label} className="flex flex-col gap-2" aria-label={g.label}>
            <h3 className="flex items-baseline justify-between text-sm font-semibold text-zinc-300">
              <span>{g.label}</span>
              <span className="text-xs font-normal text-zinc-500">
                {done} of {g.tasks.length} finished
              </span>
            </h3>
            {[...byDay.entries()].map(([day, tasks]) => (
              <div key={day} className={`overflow-hidden rounded-lg border ${day === today ? "border-zinc-500" : "border-zinc-800"}`}>
                <p className={`border-b border-zinc-800 px-4 py-1.5 text-xs ${day === today ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900/60 text-zinc-400"}`}>
                  {day === today ? "Today · " : ""}
                  {dayHeading(day, startDate, tasks[0]!)}
                </p>
                <ul className="divide-y divide-zinc-800">
                  {tasks.map((t) => (
                    <TaskRow key={t.id} slug={slug} task={t} today={today} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
