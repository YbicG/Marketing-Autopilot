"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RunEvent } from "@mkt/contracts";

/** "Picking your angles…" with a small live feed; refreshes the page when the angles land. */
export function StrategyWaiting({ runId }: { runId: string }) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (msg) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }
      if (ev.type === "stage_progress") setNote(ev.message);
      else if (ev.type === "stage_started") setNote(`${ev.label}…`);
      else if (ev.type === "stage_failed") {
        setFailed(ev.message);
        es.close();
      } else if (ev.type === "run_completed") {
        es.close();
        router.refresh();
      }
    };
    return () => es.close();
  }, [runId, router]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-zinc-800 p-5" role="status">
      {failed ? (
        <p className="text-sm text-red-400">{failed}</p>
      ) : (
        <>
          <p className="flex items-center gap-2 font-medium">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" aria-hidden />
            Picking your angles…
          </p>
          <p className="text-xs text-zinc-500">{note ?? "This takes a minute or two. You can close this tab."}</p>
        </>
      )}
    </div>
  );
}
