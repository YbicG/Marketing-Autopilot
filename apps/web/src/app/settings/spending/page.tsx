import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CAPABILITIES,
  configuredPurposes,
  formatMonthlyRange,
  formatUsd,
  isConnected,
  ledgerEntries,
  monthSpend,
  periodMonth,
  spendBreakdown,
  subscriptionSummary,
  USD,
  type LedgerEntry,
  type SpendGroup,
} from "@mkt/core/cost";
import { getWorkspace } from "@mkt/core/tenancy";
import { SettingsTabs } from "@/components/project-tabs";
import { shortDate } from "@/components/settings/vault";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../header";
import { LimitForm } from "../../welcome/limit-form";

export const dynamic = "force-dynamic";

const PROVIDER: Record<string, string> = {
  anthropic: "Claude",
  elevenlabs: "ElevenLabs",
  upload_post: "Upload-Post",
  exa: "Exa",
  brave: "Brave",
};

/** Plain-English areas for feature ids ("ingest.extract" → "Reading your product"). */
const AREA: Record<string, string> = {
  m0: "Test summary",
  ingest: "Reading your product",
  dna: "Writing your profile",
  strategy: "Picking angles",
  campaign: "Planning the campaign",
  copy: "Writing posts",
  post: "Writing posts",
  carousel: "Swipe posts",
  image: "Images",
  video: "Videos",
  tts: "Voiceovers",
  music: "Music",
  align: "Voiceovers",
  stt: "Voiceovers",
  qa: "Checks",
  capture: "Recording demos",
  analytics: "Results",
};
const areaFor = (feature: string) => AREA[feature.split(/[._]/)[0] ?? ""] ?? feature;

/** Merge feature groups into their plain-English area. */
function byArea(groups: SpendGroup[]): SpendGroup[] {
  const m = new Map<string, SpendGroup>();
  for (const g of groups) {
    const label = areaFor(g.key);
    const cur = m.get(label) ?? { key: label, label, micros: 0, inFlightMicros: 0, calls: 0 };
    cur.micros += g.micros;
    cur.inFlightMicros += g.inFlightMicros;
    cur.calls += g.calls;
    m.set(label, cur);
  }
  return [...m.values()].sort((a, b) => b.micros - a.micros);
}

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return periodMonth(d);
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const RUN_KIND: Record<string, string> = {
  m0_summary: "test summary",
  ingest: "reading your product",
  strategy: "picking angles",
  dna_regenerate: "profile refresh",
  package: "campaign",
  refill: "more posts",
  finalize: "final videos",
  capture: "demo recording",
};

export default async function SpendingPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const q = await searchParams;
  const current = periodMonth();
  const month = q.month && /^\d{4}-\d{2}$/.test(q.month) && q.month <= current ? q.month : current;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");

  const [meter, breakdown, entries, configured] = await Promise.all([
    monthSpend(db, s.workspaceId, ws.monthlyLimitMicros, month),
    spendBreakdown(db, s.workspaceId, month),
    ledgerEntries(db, s.workspaceId, { month, limit: 150 }),
    configuredPurposes(db, s.workspaceId),
  ]);
  const used = meter.spentMicros + meter.reservedMicros;
  const pct = meter.capMicros > 0 ? Math.min(100, Math.round((used / meter.capMicros) * 100)) : 0;
  const tone = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  const subs = subscriptionSummary(configured);
  const isCurrent = month === current;

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <SettingsTabs />
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Spending</h1>
            <p className="text-sm text-zinc-400">{monthLabel(month)}</p>
          </div>
          <nav className="flex gap-3 text-sm" aria-label="Month">
            <Link href={`/settings/spending?month=${shiftMonth(month, -1)}`} className="text-zinc-400 hover:text-zinc-200">
              ← {monthLabel(shiftMonth(month, -1))}
            </Link>
            {!isCurrent && (
              <Link href={`/settings/spending?month=${shiftMonth(month, 1)}`} className="text-zinc-400 hover:text-zinc-200">
                {monthLabel(shiftMonth(month, 1))} →
              </Link>
            )}
          </nav>
        </div>

        <section className="flex flex-col gap-2 rounded-md border border-zinc-800 p-4" aria-label="This month against your limit">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-2xl font-semibold">
              {formatUsd(used)} <span className="text-base font-normal text-zinc-400">of {formatUsd(meter.capMicros)} AI limit</span>
            </p>
            <p className="text-sm text-zinc-400">Subscriptions: {formatMonthlyRange(subs)}</p>
          </div>
          <div className="h-2 overflow-hidden rounded bg-zinc-800">
            <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-zinc-500">
            {formatUsd(meter.spentMicros)} spent
            {meter.reservedMicros > 0 && ` · ${formatUsd(meter.reservedMicros)} set aside for work still running`}. You get alerts at 50% and 80%;
            at 100% paid work stops until next month or until you raise the limit.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-3" aria-label="Breakdown">
          <Breakdown title="By project" groups={breakdown.byProject} link={(g) => (g.slug ? `/p/${g.slug}/plan` : null)} />
          <Breakdown title="By service" groups={breakdown.byProvider.map((g) => ({ ...g, label: PROVIDER[g.key] ?? g.key }))} />
          <Breakdown title="By kind of work" groups={byArea(breakdown.byFeature)} />
        </section>

        <section className="flex flex-col gap-3" aria-label="Every paid call">
          <div>
            <h2 className="text-lg font-semibold">Every paid call</h2>
            <p className="text-sm text-zinc-400">
              Each call sets aside its estimate first, then settles at what it actually cost. Released means it failed before anything was billed.
            </p>
          </div>
          {entries.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing spent this month.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-zinc-800">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-zinc-900/60 text-xs text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">What</th>
                    <th className="px-3 py-2 font-medium">Project</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Estimate</th>
                    <th className="px-3 py-2 text-right font-medium">Actual</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {entries.map((e) => (
                    <EntryRow key={e.id} e={e} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {entries.length >= 150 && <p className="text-xs text-zinc-500">Showing the latest 150 calls.</p>}
          {breakdown.externalMicros > 0 && (
            <p className="text-sm text-zinc-400">Subscription charges recorded this month: {formatUsd(breakdown.externalMicros)}.</p>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-label="Subscriptions and quotas">
          <div>
            <h2 className="text-lg font-semibold">Subscriptions and quotas</h2>
            <p className="text-sm text-zinc-400">
              Paid on each service&apos;s own site, outside the AI limit. Set a spending cap there too.{" "}
              <Link href="/settings/keys" className="underline underline-offset-2">
                Manage keys
              </Link>
            </p>
          </div>
          <ul className="flex flex-col divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {CAPABILITIES.map((c) => {
              const on = isConnected(c, configured);
              return (
                <li key={c.id} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">
                      {c.name}
                      <span className={`ml-2 text-xs font-normal ${on ? "text-emerald-400" : "text-zinc-500"}`}>{on ? "Connected" : "Not connected"}</span>
                    </p>
                    {c.id === "elevenlabs" && on && (
                      <p className="text-xs text-zinc-400">
                        Starter includes a monthly character allowance; move to Creator ($22) when it runs out. Keep usage-based billing off in
                        ElevenLabs.
                      </p>
                    )}
                    {c.id === "upload_post" && on && (
                      <p className="text-xs text-zinc-400">Add the X links add-on (+$19) only for launch week.</p>
                    )}
                  </div>
                  <span className="text-sm text-zinc-300">{c.priceLabel}</span>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-zinc-500">Claude is pay per use and counts toward the AI limit above.</p>
        </section>

        <section className="flex max-w-md flex-col gap-3" aria-label="Limits">
          <h2 className="text-lg font-semibold">Monthly AI limit</h2>
          <LimitForm initialUsd={Math.round(ws.monthlyLimitMicros / USD)} next="/settings/spending" />
          <p className="text-xs text-zinc-500">
            Each campaign also has its own cap (Quick $5, Standard $12, Premium $40) and reading a product stops at $1.50.
          </p>
        </section>
      </main>
    </>
  );
}

function Breakdown({ title, groups, link }: { title: string; groups: SpendGroup[]; link?: (g: SpendGroup) => string | null }) {
  const shown = groups.filter((g) => g.micros > 0 || g.calls > 0);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-800 p-4">
      <h2 className="text-sm font-medium text-zinc-300">{title}</h2>
      {shown.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {shown.map((g) => {
            const href = link?.(g);
            return (
              <li key={g.key} className="flex items-baseline justify-between gap-3">
                {href ? (
                  <Link href={href} className="truncate underline-offset-2 hover:underline">
                    {g.label}
                  </Link>
                ) : (
                  <span className="truncate">{g.label}</span>
                )}
                <span className="shrink-0 tabular-nums text-zinc-300">
                  {formatUsd(g.micros)}
                  {g.inFlightMicros > 0 && <span className="text-xs text-zinc-500"> ({formatUsd(g.inFlightMicros)} running)</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const STATUS: Record<LedgerEntry["status"], { text: string; tone: string }> = {
  reserved: { text: "Set aside", tone: "text-sky-300" },
  settled: { text: "Settled", tone: "text-emerald-400" },
  released: { text: "Released", tone: "text-zinc-500" },
};

function EntryRow({ e }: { e: LedgerEntry }) {
  const st = STATUS[e.status];
  const diff = e.status === "settled" && e.actualMicros !== null && e.estMicros > 0 ? Math.round(((e.actualMicros - e.estMicros) / e.estMicros) * 100) : null;
  return (
    <tr>
      <td className="whitespace-nowrap px-3 py-2 text-zinc-400">
        {shortDate(e.createdAt)} {e.createdAt.toISOString().slice(11, 16)}
      </td>
      <td className="px-3 py-2">
        <p>
          {areaFor(e.feature)} <span className="text-zinc-500">· {PROVIDER[e.provider] ?? e.provider}</span>
        </p>
        <p className="text-xs text-zinc-500">
          {e.model ?? e.feature}
          {e.runId && (
            <>
              {" · "}
              <Link href={`/runs/${e.runId}`} className="underline underline-offset-2">
                {e.runKind ? (RUN_KIND[e.runKind] ?? "run") : "run"}
              </Link>
            </>
          )}
        </p>
      </td>
      <td className="px-3 py-2 text-zinc-300">
        {e.productSlug ? (
          <Link href={`/p/${e.productSlug}/plan`} className="hover:underline">
            {e.productName}
          </Link>
        ) : (
          <span className="text-zinc-500">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span className={st.tone}>{st.text}</span>
        {e.error && e.status === "released" && <p className="max-w-[16rem] truncate text-xs text-zinc-500" title={e.error}>{e.error}</p>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{formatUsd(e.estMicros)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {e.actualMicros !== null && e.status === "settled" ? formatUsd(e.actualMicros) : "—"}
        {diff !== null && diff !== 0 && <p className={`text-xs ${diff > 0 ? "text-amber-300" : "text-zinc-500"}`}>{diff > 0 ? `+${diff}%` : `${diff}%`}</p>}
      </td>
    </tr>
  );
}
