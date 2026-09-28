"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "@mkt/contracts";

const REFRESH_MS = 2_500;
const FALLBACK_MS = 6_000;
/** Same as formatUsd in @mkt/core/cost (kept here so no server code reaches the browser). */
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * Live progress while kits are being written (§3.4): the runs SSE feed for each run, a throttled
 * router.refresh as parts land, and a steady fallback refresh in case the stream drops. It unmounts
 * itself once the server says nothing is being written any more.
 */
export function KitLive({ runIds }: { runIds: string[] }) {
  const router = useRouter();
  const [line, setLine] = useState("Waiting for the worker…");
  const [spent, setSpent] = useState<Record<string, number>>({});
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = runIds.join(",");

  useEffect(() => {
    const ids = key.split(",").filter(Boolean);
    if (!ids.length) return;
    const refresh = () => {
      if (timer.current) return;
      const wait = Math.max(0, REFRESH_MS - (Date.now() - last.current));
      timer.current = setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        router.refresh();
      }, wait);
    };
    const sources = ids.map((id) => {
      const es = new EventSource(`/api/runs/${id}/events`);
      es.onmessage = (msg) => {
        let ev: RunEvent;
        try {
          ev = JSON.parse(msg.data) as RunEvent;
        } catch {
          return;
        }
        if (ev.type === "stage_started") setLine(`${ev.label}…`);
        else if (ev.type === "stage_warning") setLine(ev.message);
        else if (ev.type === "cost_update") setSpent((s) => ({ ...s, [id]: ev.spentMicros }));
        else if (ev.type === "artifact_ready" || ev.type === "stage_failed") refresh();
        else if (ev.type === "needs_input" || ev.type === "run_completed") {
          es.close();
          refresh();
        }
      };
      return es;
    });
    const fallback = setInterval(() => router.refresh(), FALLBACK_MS);
    return () => {
      for (const es of sources) es.close();
      clearInterval(fallback);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [key, router]);

  const total = Object.values(spent).reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-900/70 bg-sky-950/20 px-4 py-3 text-sm" role="status">
      <span className="flex items-center gap-2">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-sky-400 motion-safe:animate-pulse" />
        Writing your launch kit. {line}
      </span>
      <span className="flex items-center gap-3 text-xs text-zinc-400">
        {total > 0 && <span>{usd(total)} so far</span>}
        <button type="button" onClick={() => router.refresh()} className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-zinc-200 md:min-h-0">
          Refresh
        </button>
      </span>
    </div>
  );
}
