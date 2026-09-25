import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatUsd } from "@mkt/core/cost";
import { TIER_LABELS, WEB_GENERATORS, activeCampaignRuns, campaignBoard, latestCampaign, type BoardCard, type BoardDay, type BoardStatus } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { editorHref } from "@/components/content/links";
import { OpenSlots } from "@/components/content/open-slots";
import { RunProgress } from "@/components/content/run-progress";
import { AiLabelChip, DOT, PLATFORM_NAME, StatusChip } from "@/components/content/status";
import { ProjectTabs } from "@/components/project-tabs";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../header";

export const dynamic = "force-dynamic";

const STATUS_ORDER: BoardStatus[] = ["Needs you", "Ready", "Drafting", "Approved", "Scheduled", "Posted", "Failed"];

const shortDate = (iso: string) =>
  iso ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`)) : "";
const weekday = (iso: string) => (iso ? new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`)) : "");

/** Campaign board (§2.3): a 30-day strip plus groups by type, live while the package is writing. */
export default async function ContentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const latest = await latestCampaign(db, s.workspaceId, product.id);
  const board = latest ? await campaignBoard(db, s.workspaceId, latest.campaign.id, WEB_GENERATORS) : null;
  const runs = latest ? await activeCampaignRuns(db, s.workspaceId, product.id, latest.campaign.id) : [];

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={product.slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
        {!latest || !board ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">Content</h1>
            <p className="text-zinc-400">
              No campaign yet.{" "}
              <Link href={`/p/${encodeURIComponent(product.slug)}/plan`} className="underline underline-offset-2">
                Go to your plan
              </Link>{" "}
              and press Make my campaign.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm text-zinc-500">
                  {TIER_LABELS[latest.campaign.tier]} campaign · starts {shortDate(latest.campaign.startDate)} · launch {shortDate(latest.campaign.launchDate)}
                </p>
                <h1 className="text-2xl font-semibold">{product.name}</h1>
              </div>
              <div className="text-right text-sm text-zinc-400">
                <p>Spent so far {formatUsd(board.totals.costMicros)}</p>
                <p className="text-xs text-zinc-500">
                  {STATUS_ORDER.filter((k) => board.totals.byStatus[k] > 0)
                    .map((k) => `${board.totals.byStatus[k]} ${k.toLowerCase()}`)
                    .concat(board.totals.open ? [`${board.totals.open} open`] : [])
                    .join(" · ")}
                </p>
              </div>
            </div>

            {runs.slice(0, 3).map((r) => (
              <RunProgress key={r.id} slug={product.slug} runId={r.id} status={r.status} label={r.kind === "package" ? "Writing your campaign" : "Making more"} />
            ))}

            {board.totals.byStatus.Ready > 0 && (
              <p className="text-sm text-zinc-400">
                {board.totals.byStatus.Ready} ready for you to check.{" "}
                <Link href={`/p/${encodeURIComponent(product.slug)}/queue`} className="underline underline-offset-2">
                  Approve them in the Queue
                </Link>
              </p>
            )}

            <Strip slug={product.slug} strip={board.strip} />

            {board.groups.map((g) => (
              <section key={g.kind} className="flex flex-col gap-3" aria-label={g.label}>
                <h2 className="text-lg font-semibold">
                  {g.label} <span className="text-sm font-normal text-zinc-500">{g.cards.length}</span>
                </h2>
                {g.cards.length > 0 && (
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {g.cards.map((c) => (
                      <li key={c.contentItemId}>
                        <Card slug={product.slug} card={c} />
                      </li>
                    ))}
                  </ul>
                )}
                <OpenSlots
                  slug={product.slug}
                  campaignId={latest.campaign.id}
                  slots={g.open.map((o) => ({
                    slotId: o.slotId,
                    day: o.day,
                    date: o.date,
                    platformName: PLATFORM_NAME[o.platform] ?? o.platform,
                    label: o.label,
                    priceMicros: o.priceMicros,
                    available: o.available,
                  }))}
                />
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}

function Strip({ slug, strip }: { slug: string; strip: BoardDay[] }) {
  return (
    <section aria-label="Your 30 days" className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Your 30 days</h2>
      <ol className="grid grid-cols-6 gap-1 sm:grid-cols-10 lg:grid-cols-15">
        {strip.map((d) => (
          <li
            key={d.day}
            className={`flex min-h-16 flex-col gap-1 rounded border p-1.5 text-[11px] ${d.launch ? "border-amber-500 bg-amber-950/20" : "border-zinc-800"}`}
            title={d.launch ? "Launch day" : undefined}
          >
            <span className="flex justify-between text-zinc-500">
              <span>{weekday(d.date)}</span>
              <span>{shortDate(d.date)}</span>
            </span>
            {d.launch && <span className="font-medium text-amber-300">Launch</span>}
            <span className="flex flex-wrap gap-1">
              {d.entries.map((e) => {
                const dot = <span className={`block h-2.5 w-2.5 rounded-full ${DOT[e.status]}`} />;
                const label = `${PLATFORM_NAME[e.platform] ?? e.platform} ${e.time}: ${e.status}`;
                return e.contentItemId ? (
                  <Link key={e.slotId} href={editorHref(slug, { kind: e.kind, contentItemId: e.contentItemId })} title={label} aria-label={label}>
                    {dot}
                  </Link>
                ) : (
                  <span key={e.slotId} title={label} aria-label={label}>
                    {dot}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ol>
      <p className="flex flex-wrap gap-3 text-xs text-zinc-500">
        {(["Drafting", "Ready", "Needs you", "Approved", "Scheduled", "Posted", "Failed", "Open"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-full ${DOT[k]}`} />
            {k}
          </span>
        ))}
      </p>
    </section>
  );
}

function Card({ slug, card }: { slug: string; card: BoardCard }) {
  const img = card.thumbnailAssetId && card.kind !== "video" ? `/api/media/${card.thumbnailAssetId}` : null;
  return (
    <Link href={editorHref(slug, card)} className="flex h-full flex-col gap-2 rounded-md border border-zinc-800 p-3 hover:border-zinc-600">
      {img ? (
        <img src={img} alt={`${card.typeLabel} preview`} loading="lazy" className="h-32 w-full rounded bg-zinc-900 object-cover object-top" />
      ) : (
        (card.kind === "carousel" || card.kind === "video") && (
          <div className="flex h-32 w-full items-center justify-center rounded bg-zinc-900 text-xs text-zinc-600">
            {card.status === "Drafting" ? "Being made…" : "No preview yet"}
          </div>
        )
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {card.typeLabel}
          {card.day !== null && <span className="font-normal text-zinc-500"> · day {card.day}</span>}
        </span>
        <StatusChip status={card.status} />
      </div>
      {card.platforms.length > 0 && <p className="text-xs text-zinc-400">{card.platforms.map((p) => PLATFORM_NAME[p] ?? p).join(", ")}</p>}
      {card.angle && <p className="truncate text-xs text-zinc-500">Angle #{card.angle.idx + 1}: {card.angle.title}</p>}
      {card.reason && card.status === "Needs you" && <p className="text-xs text-amber-300">{card.reason}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-xs">
        <span className={card.checks.blocks ? "text-red-400" : card.checks.warns ? "text-amber-300" : "text-zinc-500"}>
          {card.checks.blocks ? `${card.checks.blocks} to fix` : card.checks.warns ? `${card.checks.warns} to check` : "Checks pass"}
        </span>
        <span className="text-zinc-500">{formatUsd(card.costMicros)}</span>
        <AiLabelChip tier={card.aiLabel} />
        {card.stale && <span className="text-amber-400">Profile changed since</span>}
      </div>
    </Link>
  );
}
