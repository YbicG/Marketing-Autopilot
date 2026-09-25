"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RunEvent } from "@mkt/contracts";

type Line = { key: number; tone: "info" | "fact" | "error" | "done"; text: string };

/** §3.4: EventSource resumes with Last-Event-ID on its own after a refresh-free reconnect. */
export function LiveFeed({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [spent, setSpent] = useState<number | null>(null);
  const [finished, setFinished] = useState(initialStatus === "failed");

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    let n = 0;
    const push = (tone: Line["tone"], text: string) => setLines((prev) => [...prev, { key: n++, tone, text }]);

    es.onmessage = (msg) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }
      switch (ev.type) {
        case "stage_started":
          push("info", `${ev.label}…`);
          break;
        case "fact_found":
          push("fact", ev.text);
          break;
        case "cost_update":
          setSpent(ev.spentMicros);
          break;
        case "stage_failed":
          push("error", ev.message);
          setFinished(true);
          es.close();
          break;
        case "run_completed":
          push("done", "Done.");
          es.close();
          router.refresh();
          break;
      }
    };
    return () => es.close();
  }, [runId, router]);

  const color = { info: "text-zinc-300", fact: "text-zinc-400", error: "text-red-400", done: "text-emerald-400" };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-zinc-800 p-6">
      {lines.length === 0 && !finished && <p className="text-zinc-500">Waiting for the worker…</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {lines.map((l) => (
          <li key={l.key} className={color[l.tone]}>
            {l.tone === "fact" ? `· ${l.text}` : l.text}
          </li>
        ))}
      </ul>
      {spent !== null && <p className="text-xs text-zinc-500">Spent ${(spent / 1_000_000).toFixed(4)}</p>}
    </div>
  );
}
