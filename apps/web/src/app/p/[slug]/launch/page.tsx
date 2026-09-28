import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatUsd, loadRateCards, rateLookup } from "@mkt/core/cost";
import { latestCampaign } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { buildLaunchTasks, estimateLandingAuditMicros, launchDayView, launchTemplate, launchView } from "@mkt/core/launch";
import { addDays, launchDayVerdict, plainDay, suggestedXLinksWindow, X_LINKS_MAX_DAYS, xLinksWindowOf } from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { GatesPanel } from "@/components/launch/gates-panel";
import { countdownText, LaunchDay } from "@/components/launch/launch-day";
import { PlanChecklist, TaskRow } from "@/components/launch/plan-checklist";
import { PlanStart } from "@/components/launch/plan-start";
import { PlanRefresh } from "@/components/launch/plan-task-actions";
import { XLinksCard } from "@/components/launch/x-links-card";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Launch (§2.3, M4-LC): the D30 checklist tagged Auto/Assisted/You/Gate, the checks, launch day, X links. */
export default async function LaunchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();

  const now = new Date();
  const [view, latest] = await Promise.all([launchView(db, s.workspaceId, product.id, now), latestCampaign(db, s.workspaceId, product.id)]);
  const launchDate = view?.plan.launchDate ?? latest?.campaign.launchDate ?? null;
  const xLinks = launchDate ? (
    <XLinksCard slug={product.slug} current={xLinksWindowOf(product)} suggested={suggestedXLinksWindow(launchDate)} maxDays={X_LINKS_MAX_DAYS} />
  ) : null;

  const shell = (body: React.ReactNode) => (
    <>
      <main className="flex max-w-5xl flex-col gap-8 px-4 md:px-10 py-8">{body}</main>
    </>
  );

  if (!view) {
    if (!latest) {
      return shell(
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-500">{product.name}</p>
          <h1 className="font-serif text-4xl tracking-tight">Launch</h1>
          <p className="text-zinc-400">
            The launch checklist is worked back from your campaign&apos;s dates.{" "}
            <Link href={`/p/${encodeURIComponent(product.slug)}/plan`} className="underline underline-offset-2">
              Go to your plan
            </Link>{" "}
            and press Make my campaign first.
          </p>
        </div>,
      );
    }
    const c = latest.campaign;
    const template = launchTemplate();
    const optionalKeys = new Set(template.tasks.filter((t) => t.optional).map((t) => t.key));
    let built: ReturnType<typeof buildLaunchTasks> = [];
    try {
      built = buildLaunchTasks(template, { launchDate: c.launchDate, startDate: c.startDate, timeZone: ws.timezone, today: now, optionalOn: optionalKeys });
    } catch {
      // Bad campaign dates: the create route explains; the card still renders.
    }
    // The Product Hunt launch-day row comes with its booking row (the plan route adds it), so only the booking is offered.
    const optional = built.filter((b) => b.optional && b.mode !== "assisted").map((b) => ({ key: b.key, title: b.title, detail: b.detail, due: plainDay(b.dueDate) }));
    return shell(
      <>
        <div>
          <p className="text-sm text-zinc-500">{product.name}</p>
          <h1 className="font-serif text-4xl tracking-tight">Launch</h1>
        </div>
        <PlanStart
          slug={product.slug}
          start={plainDay(c.startDate)}
          launch={plainDay(c.launchDate)}
          end={plainDay(addDays(c.startDate, 29))}
          optional={optional}
        />
        {xLinks}
      </>,
    );
  }

  const day = await launchDayView(db, s.workspaceId, product.id, now);
  const tasks = view.groups.flatMap((g) => g.tasks);
  const testUrl = tasks.find((t) => t.key === "gate.tracking_test")?.ref?.testUrl ?? null;
  const auditPrice = formatUsd(estimateLandingAuditMicros(rateLookup(await loadRateCards(db))));
  const verdict = launchDayVerdict({
    localDate: view.countdown.today,
    launch: {
      launchDate: view.plan.launchDate,
      open: view.gates.gates.filter((g) => !g.passed).map((g) => ({ key: g.key, title: g.title, status: "todo", passed: false })),
    },
    warnings: [],
  });
  const campaignMoved =
    !!latest && (latest.campaign.id !== view.plan.campaignId || latest.campaign.launchDate !== view.plan.launchDate || latest.campaign.startDate !== view.plan.startDate);
  const a = view.autoApproval;
  const isLaunchDay = view.countdown.isLaunchDay;
  const dayPanel = day ? <LaunchDay slug={product.slug} view={day} tz={ws.timezone} block={verdict.block} prominent={isLaunchDay} /> : null;

  return shell(
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-500">{product.name}</p>
          <h1 className="font-serif text-4xl tracking-tight">Launch</h1>
          <p className="text-sm text-zinc-400">
            {countdownText(view.countdown)} · launch day {plainDay(view.plan.launchDate)} · {view.counts.done + view.counts.skipped} of {view.counts.total} finished
          </p>
          <p className={`text-xs ${a.onTrack ? "text-emerald-400" : "text-zinc-500"}`}>
            Posts for days {a.fromDay}–{a.toDay}: {a.approved} of {a.total} approved ({a.pct}%). Aim for {a.targetPct}% by {plainDay(a.dueDate)}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/p/${product.slug}/launch/kits`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
            Launch kit
          </Link>
          <PlanRefresh slug={product.slug} />
        </div>
      </div>

      {campaignMoved && (
        <p className="rounded-md border border-amber-700/70 bg-amber-950/30 px-4 py-2 text-sm text-amber-200">
          Your campaign&apos;s dates changed since this checklist was made. Press Check again to move the open steps to the new dates. Finished steps stay as they are.
        </p>
      )}

      {isLaunchDay && dayPanel}

      {view.overdue.length > 0 && !isLaunchDay && (
        <section className="flex flex-col gap-2" aria-label="Late">
          <h2 className="text-lg font-semibold">Late</h2>
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-amber-700/50">
            {view.overdue.map((t) => (
              <TaskRow key={t.id} slug={product.slug} task={t} today={view.countdown.today} />
            ))}
          </ul>
        </section>
      )}

      <GatesPanel slug={product.slug} gates={view.gates} testUrl={testUrl} audit={view.latestAudit} auditPrice={auditPrice} website={product.urls.website ?? null} />

      <section className="flex flex-col gap-3" aria-label="Checklist">
        <div>
          <h2 className="text-lg font-semibold">Checklist</h2>
          <p className="text-sm text-zinc-400">
            <span className="text-sky-300">Auto</span> the app does it · <span className="text-violet-300">Assisted</span> the app writes it, you post it ·{" "}
            <span className="text-amber-200">You</span> only you can do it · <span className="text-rose-300">Gate</span> a check that has to pass
          </p>
        </div>
        <PlanChecklist slug={product.slug} groups={view.groups} startDate={view.plan.startDate} today={view.countdown.today} />
      </section>

      {!isLaunchDay && dayPanel}

      {xLinks}
    </>,
  );
}
