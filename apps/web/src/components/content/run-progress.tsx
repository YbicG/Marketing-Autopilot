"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "@mkt/contracts";
import { postJson } from "@/lib/post-json";

const REFRESH_MS = 3_000;
const FALLBACK_MS = 20_000;

/**
 * Live progress for a package / refill run on the board (§3.4): the runs SSE feed, with a
 * throttled router.refresh as pieces land so the cards fill in. A slow fallback refresh covers a
 * dropped stream.
 */
export function RunProgress({ slug, runId, status, label }: { slug: string; runId: string; status: string; label: string }) {
  const router = useRouter();
  const [line, setLine] = useState<string>(status === "queued" ? "Waiting for the worker…" : "Working…");
  const [done, setDone] = useState(0);
  const [spent, setSpent] = useState<number | null>(null);
  // The server's status is the truth: a replayed pause from before a resume must not show again.
  const paused = status === "paused_budget";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (paused) return;
    const refresh = () => {
      const wait = REFRESH_MS - (Date.now() - last.current);
      if (timer.current) return;
      timer.current = setTimeout(
        () => {
          timer.current = null;
          last.current = Date.now();
          router.refresh();
        },
        Math.max(0, wait),
      );
    };
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (msg) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }
      if (ev.type === "stage_started") setLine(`${ev.label}…`);
      else if (ev.type === "stage_warning") setLine(ev.message);
      else if (ev.type === "cost_update") setSpent(ev.spentMicros);
      else if (ev.type === "artifact_ready") {
        setDone((n) => n + 1);
        refresh();
      } else if (ev.type === "stage_failed") {
        refresh();
      } else if (ev.type === "needs_input" || ev.type === "run_completed") {
        setLine("All written. Have a look.");
        es.close();
        router.refresh();
      }
    };
    const fallback = setInterval(() => router.refresh(), FALLBACK_MS);
    return () => {
      es.close();
      clearInterval(fallback);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId, paused, router]);

  async function carryOn() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/products/${encodeURIComponent(slug)}/package/resume`, { runId });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }

  if (paused) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-amber-800 bg-amber-950/20 px-4 py-3 text-sm">
        <p className="text-amber-200">{label}: paused because it would go over your spending limit.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/settings" className="underline underline-offset-2">
            Raise limit
          </Link>
          <button type="button" onClick={() => void carryOn()} disabled={busy} className="rounded-md border border-zinc-600 px-3 py-1 text-xs hover:border-zinc-400 disabled:opacity-60">
            {busy ? "Starting…" : "Carry on"}
          </button>
        </div>
        {error && <p className="text-red-400">{error}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-900/70 bg-sky-950/20 px-4 py-3 text-sm" aria-live="polite">
      <p>
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" />
        {label}: {line}
        {done > 0 && <span className="text-zinc-400"> · {done} written so far</span>}
      </p>
      <p className="text-xs text-zinc-500">
        {spent !== null && `Spent ${spent < 10_000 ? `$${(spent / 1e6).toFixed(4)}` : `$${(spent / 1e6).toFixed(2)}`} · `}You can close this tab.
      </p>
    </div>
  );
}
