"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

export function LimitForm({ initialUsd, next }: { initialUsd: number; next: string }) {
  const router = useRouter();
  const [usd, setUsd] = useState(String(initialUsd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const out = await postJson("/api/settings/limit", { usd: Number(usd) });
    if (!out.ok) {
      setError(out.error);
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <label className="flex min-h-11 items-center gap-2 rounded-md border border-edge bg-zinc-900 px-3 py-2 focus-within:border-zinc-400">
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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "limit-error" : undefined}
        />
        <span className="text-sm text-zinc-500">/ month</span>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="min-h-11 rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-zinc-50 hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? "Saving…" : "Save and continue"}
      </button>
      {error && (
        <p id="limit-error" role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
