"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LimitForm({ initialUsd, next }: { initialUsd: number; next: string }) {
  const router = useRouter();
  const [usd, setUsd] = useState(String(initialUsd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings/limit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: Number(usd) }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Couldn't save the limit.");
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <label className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
        <span className="text-zinc-400">$</span>
        <input
          type="number"
          min={1}
          max={1000}
          step={1}
          value={usd}
          onChange={(e) => setUsd(e.target.value)}
          className="w-full bg-transparent outline-none"
          aria-label="Monthly limit in dollars"
        />
        <span className="text-sm text-zinc-500">/ month</span>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
      >
        {busy ? "Saving…" : "Save and continue"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
