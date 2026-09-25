"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/**
 * "Pause all posting" (§2.1 principle 7, §5.8 step 5): always one click, always visible on Queue
 * and Today. Pauses this project or everything; Resume appears while anything is paused.
 */
export function PauseControls({ slug, pausedCount }: { slug: string; pausedCount: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(scope: string, action: "pause" | "resume") {
    setBusy(`${action}:${scope}`);
    setError(null);
    setNote(null);
    const out = await postJson<{ paused?: number; queued?: number; missed?: number }>("/api/pause", { scope, action });
    setBusy(null);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    const d = out.data;
    if (action === "pause") setNote(d.paused ? `Paused ${d.paused} post${d.paused === 1 ? "" : "s"}. Nothing will go out until you resume.` : "Nothing was scheduled, so nothing needed pausing.");
    else setNote(`Resumed ${d.queued ?? 0} post${d.queued === 1 ? "" : "s"}.${d.missed ? ` ${d.missed} missed their slot while paused; they're in Needs you.` : ""}`);
    router.refresh();
  }

  const btn = "rounded-md border px-3 py-1.5 text-sm disabled:opacity-60";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run(slug, "pause")}
          disabled={!!busy}
          className={`${btn} border-red-800 bg-red-950/40 text-red-100 hover:border-red-600`}
        >
          {busy === `pause:${slug}` ? "Pausing…" : "Pause all posting"}
        </button>
        <button type="button" onClick={() => void run("all", "pause")} disabled={!!busy} className={`${btn} border-zinc-700 text-zinc-300 hover:border-zinc-500`}>
          {busy === "pause:all" ? "Pausing…" : "Pause every project"}
        </button>
        {pausedCount > 0 && (
          <>
            <button type="button" onClick={() => void run(slug, "resume")} disabled={!!busy} className={`${btn} border-emerald-800 text-emerald-200 hover:border-emerald-600`}>
              {busy === `resume:${slug}` ? "Resuming…" : `Resume posting (${pausedCount} paused)`}
            </button>
            <button type="button" onClick={() => void run("all", "resume")} disabled={!!busy} className={`${btn} border-zinc-700 text-zinc-300 hover:border-zinc-500`}>
              {busy === "resume:all" ? "Resuming…" : "Resume every project"}
            </button>
          </>
        )}
      </div>
      {note && <p className="text-xs text-zinc-400">{note}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
