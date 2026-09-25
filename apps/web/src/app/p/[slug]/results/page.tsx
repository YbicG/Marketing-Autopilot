import { notFound, redirect } from "next/navigation";
import type { AngleResultRow } from "@mkt/contracts";
import { makeMoreEstimate, resultsByAngle } from "@mkt/core/analytics";
import { formatUsd } from "@mkt/core/cost";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { ProjectTabs } from "@/components/project-tabs";
import { AngleActions } from "@/components/results/angle-actions";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../header";

export const dynamic = "force-dynamic";

const num = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));
const pct = (n: number | null) => (n === null ? "—" : `${n}%`);

const SIGNUP_NOTE: Record<AngleResultRow["signupSignal"], string> = {
  none: "No signup numbers yet.",
  positive: "Brought signups.",
  neutral: "Some visits, no signups yet.",
  negative: "Many visits, no signups.",
};

/** Why "Turn into an ad" is off, in plain words. */
function adReason(r: AngleResultRow, min: number): string {
  if (r.canTurnIntoAd) return "";
  if (r.maturePosts < min) return `it needs ${min} posts with results first.`;
  if (r.signupSignal === "none") return "it needs signup numbers first.";
  if (r.signupSignal === "negative") return "its visits haven't turned into signups.";
  if (!r.winner) return "only the top angle, with signups behind it, can become an ad.";
  return "not available yet.";
}

export default async function ResultsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const [results, more] = await Promise.all([resultsByAngle(db, s.workspaceId, product.id), makeMoreEstimate(db, s.workspaceId, product.id)]);
  const min = results.minMaturePosts;
  const ranked = results.rows.filter((r) => r.rank !== null);
  const waiting = results.rows.filter((r) => r.rank === null);
  const morePrice = formatUsd(more.estimateMicros);

  const card = (r: AngleResultRow) => (
    <li key={r.angleId} className={`flex flex-col gap-3 rounded-md border p-4 ${r.winner ? "border-emerald-800" : "border-zinc-800"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">
          {r.rank !== null && <span className="mr-2 text-zinc-500">#{r.rank}</span>}
          {r.title}
          {r.status === "stopped" && <span className="ml-2 rounded border border-zinc-700 px-1.5 py-0.5 text-xs font-normal text-zinc-400">Stopped</span>}
          {r.winner && <span className="ml-2 rounded border border-emerald-800 px-1.5 py-0.5 text-xs font-normal text-emerald-300">Doing best</span>}
        </h3>
        <span className="text-xs text-zinc-500">
          {r.posts} post{r.posts === 1 ? "" : "s"} · {r.maturePosts} with results
        </span>
      </div>
      {r.rank === null && (
        <p className="text-sm text-zinc-400">
          Not enough posts yet: {Math.min(r.maturePosts, min)} of {min}. <span className="text-zinc-500">A post counts once it has been up about 3 days.</span>
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-zinc-500">Views</dt>
          <dd>{num(r.views)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">% who tapped the link</dt>
          <dd>{pct(r.linkTapPct)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Profile visits</dt>
          <dd>{num(r.profileVisits)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Signups</dt>
          <dd>
            {num(r.signups)}
            {r.visits !== null && <span className="text-xs text-zinc-500"> from {num(r.visits)} visits</span>}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-zinc-500">{SIGNUP_NOTE[r.signupSignal]}</p>
      <AngleActions
        slug={slug}
        angleId={r.angleId}
        status={r.status}
        moreCount={more.count}
        morePrice={morePrice}
        canTurnIntoAd={r.canTurnIntoAd}
        adReason={adReason(r, min)}
      />
    </li>
  );

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Results</h1>
          <p className="text-sm text-zinc-400">
            How each angle is doing, from measured numbers only. An angle is ranked once {min} of its posts have been up long enough to count. Signups count most, then link taps
            and profile visits, then views.
          </p>
        </div>
        {results.rows.length === 0 ? (
          <p className="text-sm text-zinc-500">No angles yet. Make a campaign first; results show up here after posts go live.</p>
        ) : (
          <>
            {ranked.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="font-semibold">Ranked</h2>
                <ol className="flex flex-col gap-3">{ranked.map(card)}</ol>
              </section>
            )}
            {waiting.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="font-semibold">{ranked.length ? "Waiting for results" : "Not ranked yet"}</h2>
                <ul className="flex flex-col gap-3">{waiting.map(card)}</ul>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
