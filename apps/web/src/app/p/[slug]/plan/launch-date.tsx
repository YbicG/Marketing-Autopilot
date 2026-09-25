"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/** Launch day: shown and changeable. */
export function LaunchDate({ slug, strategyId, initial, reason }: { slug: string; strategyId: string; initial: string | null; reason: string | null }) {
  const router = useRouter();
  const [date, setDate] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!date) return;
    setBusy(true);
    setMsg(null);
    const out = await postJson(`/api/products/${encodeURIComponent(slug)}/dna`, { action: "launch_date", strategyId, date });
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "error", text: out.error });
    setMsg({ tone: "ok", text: "Saved." });
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-zinc-800 p-5" aria-label="Launch day">
      <h2 className="text-lg font-semibold">Launch day</h2>
      {reason && <p className="text-sm text-zinc-400">{reason}</p>}
      <form onSubmit={save} className="flex items-center gap-2">
        <label htmlFor="launch-date" className="sr-only">
          Launch day
        </label>
        <input
          id="launch-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-600"
        />
        <button
          type="submit"
          disabled={busy || !date || date === initial}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Change"}
        </button>
        {msg && <span className={`text-xs ${msg.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</span>}
      </form>
    </section>
  );
}
