"use client";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/** Pick a new day and time (in the workspace's time zone; the server converts). */
export function RescheduleForm({ postId, day, time, onDone, label = "Reschedule" }: { postId: string; day: string; time: string; onDone: () => void; label?: string }) {
  const [d, setD] = useState(day);
  const [t, setT] = useState(time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/posts/${postId}/reschedule`, { day: d, time: t });
    setBusy(false);
    if (!out.ok) setError(out.error);
    else onDone();
  }

  const input = "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={d} onChange={(e) => setD(e.target.value)} aria-label="Day" className={input} />
        <input type="time" value={t} onChange={(e) => setT(e.target.value)} aria-label="Time" className={input} />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !d || !t}
          className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
        >
          {busy ? "Moving…" : label}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
