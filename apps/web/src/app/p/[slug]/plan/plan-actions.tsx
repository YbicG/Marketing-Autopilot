"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

type Tier = "quick" | "standard" | "premium";
const TIERS: { id: Tier; label: string; blurb: string }[] = [
  { id: "quick", label: "Quick", blurb: "A taste: about a third of the posts" },
  { id: "standard", label: "Standard", blurb: "The full 30 days" },
  { id: "premium", label: "Premium", blurb: "About twice the posts" },
];

export interface PackageChoice {
  /** Recipe platforms for this product, in order, with display names. */
  platforms: { id: string; name: string }[];
  /** `${tier}|${sorted platforms}` → micros (core packageOptions). */
  estimates: Record<string, { expected: number; high: number; capMicros: number }>;
  leftMicros: number;
}

const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
const keyFor = (tier: Tier, platforms: string[]) => `${tier}|${[...platforms].sort().join(",")}`;

/** Make my campaign (M2) · Regenerate profile · Export brief. */
export function PlanActions({
  slug,
  hasProfile,
  hasAngles,
  choice,
  campaignHref,
}: {
  slug: string;
  hasProfile: boolean;
  hasAngles: boolean;
  choice: PackageChoice;
  /** The board, when a campaign already exists. */
  campaignHref: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"regen" | "make" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overLimit, setOverLimit] = useState<{ quickFits: boolean } | null>(null);
  const [tier, setTier] = useState<Tier>("standard");
  const [platforms, setPlatforms] = useState<string[]>(choice.platforms.map((p) => p.id));
  const base = `/api/products/${encodeURIComponent(slug)}`;
  const est = platforms.length ? choice.estimates[keyFor(tier, platforms)] : undefined;
  const quickEst = platforms.length ? choice.estimates[keyFor("quick", platforms)] : undefined;
  const wouldBreak = !!est && est.high > choice.leftMicros;

  async function regenerate() {
    setBusy("regen");
    setError(null);
    const out = await postJson<{ runId?: string }>(`${base}/regenerate`, {});
    if (!out.ok || !out.data.runId) {
      setError(out.ok ? "Couldn't start. Try again." : out.error);
      setBusy(null);
      return;
    }
    router.push(`/runs/${out.data.runId}`);
  }

  async function make() {
    setBusy("make");
    setError(null);
    setOverLimit(null);
    const out = await postJson<{ href?: string }>(`${base}/package`, { tier, platforms });
    if (!out.ok) {
      setBusy(null);
      setError(out.error);
      if (/limit/i.test(out.error)) setOverLimit({ quickFits: !!quickEst && quickEst.high <= choice.leftMicros && tier !== "quick" });
      return;
    }
    router.push(out.data.href ?? `/p/${encodeURIComponent(slug)}/content`);
  }

  const toggle = (id: string) => setPlatforms((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const secondary = "rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60";
  const canMake = hasProfile && hasAngles && platforms.length > 0 && !!est;
  const picker = (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm text-zinc-400">How much to make</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {TIERS.map((t) => {
            const e = platforms.length ? choice.estimates[keyFor(t.id, platforms)] : undefined;
            const on = tier === t.id;
            return (
              <label key={t.id} className={`flex cursor-pointer flex-col gap-0.5 rounded-md border p-3 text-sm ${on ? "border-zinc-300 bg-zinc-900" : "border-zinc-800 hover:border-zinc-600"}`}>
                <span className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="tier" value={t.id} checked={on} onChange={() => setTier(t.id)} className="accent-zinc-100" />
                    {t.label}
                  </span>
                  <span className="text-zinc-300">{e ? `~${usd(e.expected)}` : "—"}</span>
                </span>
                <span className="text-xs text-zinc-500">{t.blurb}</span>
                {e && <span className="text-xs text-zinc-600">Stops at {usd(e.capMicros)}</span>}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm text-zinc-400">Where to post</legend>
        <div className="flex flex-wrap gap-2">
          {choice.platforms.map((p) => (
            <label key={p.id} className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm ${platforms.includes(p.id) ? "border-zinc-400" : "border-zinc-800 text-zinc-500"}`}>
              <input type="checkbox" checked={platforms.includes(p.id)} onChange={() => toggle(p.id)} className="accent-zinc-100" />
              {p.name}
            </label>
          ))}
        </div>
        {!platforms.length && <p className="text-xs text-amber-300">Pick at least one place to post.</p>}
      </fieldset>
      {wouldBreak && (
        <p className="text-sm text-amber-300">
          This could cost up to {usd(est.high)} and you have {usd(choice.leftMicros)} left this month.{" "}
          {tier !== "quick" && quickEst && quickEst.high <= choice.leftMicros && (
            <button type="button" onClick={() => setTier("quick")} className="underline underline-offset-2">
              Switch to Quick
            </button>
          )}{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Raise limit
          </Link>
        </p>
      )}
      <div>
        <button
          type="button"
          onClick={() => void make()}
          disabled={!canMake || busy !== null}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {busy === "make" ? "Starting…" : `${campaignHref ? "Make a new campaign" : "Make my campaign"} · ~${est ? usd(est.expected) : "$0.00"}`}
        </button>
        {!hasAngles && hasProfile && <p className="mt-1 text-xs text-zinc-500">Your angles need to be ready first.</p>}
        <p className="mt-1 text-xs text-zinc-500">Nothing posts until you approve it. You can close the tab while it writes.</p>
      </div>
    </div>
  );

  return (
    <section className="flex flex-col gap-5 rounded-md border border-zinc-800 p-5" aria-label="Next steps">
      {campaignHref ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Link href={campaignHref} className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white">
              Open your campaign
            </Link>
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-zinc-400">Make a fresh campaign instead</summary>
            <p className="mt-2 text-xs text-zinc-500">Your current campaign stays as it is. Skip its posts in the Queue if you don&apos;t want both.</p>
            <div className="mt-3">{picker}</div>
          </details>
        </div>
      ) : (
        picker
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-4">
        <button type="button" onClick={() => void regenerate()} disabled={busy !== null || !hasProfile} className={secondary}>
          {busy === "regen" ? "Starting…" : "Regenerate profile · ~$0.30"}
        </button>
        {hasProfile && (
          <a href={`${base}/brief`} download className={secondary}>
            Export brief
          </a>
        )}
      </div>
      <p className="text-xs text-zinc-500">Regenerating keeps anything you pinned or fixed.</p>
      {error && (
        <p className="text-sm text-red-400">
          {error}{" "}
          {overLimit?.quickFits && (
            <button
              type="button"
              onClick={() => {
                setTier("quick");
                setError(null);
                setOverLimit(null);
              }}
              className="underline underline-offset-2"
            >
              Switch to Quick
            </button>
          )}{" "}
          {overLimit && (
            <Link href="/settings" className="underline underline-offset-2">
              Raise limit
            </Link>
          )}
        </p>
      )}
    </section>
  );
}
