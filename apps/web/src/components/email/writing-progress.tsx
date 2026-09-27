"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RunEvent } from "@mkt/contracts";

const FALLBACK_MS = 10_000;

/** While email.draft runs: the runs SSE feed, refreshing the page when it lands (slow poll as a fallback). */
export function WritingProgress({ runId, status }: { runId: string; status: string }) {
  const router = useRouter();
  const [line, setLine] = useState(status === "queued" ? "Waiting for the worker…" : "Writing your email…");

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (msg) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }
      if (ev.type === "stage_started") setLine(`${ev.label}…`);
      else if (ev.type === "run_completed" || ev.type === "stage_failed") {
        es.close();
        router.refresh();
      }
    };
    const t = setInterval(() => router.refresh(), FALLBACK_MS);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [runId, router]);

  return (
    <p className="rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-300" role="status">
      {line} This takes about half a minute.
    </p>
  );
}
