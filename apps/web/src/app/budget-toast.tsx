"use client";
import Link from "next/link";
import { useState } from "react";

/** §7.1 step 7: the highest open budget alert, shown under the header until dismissed. */
export function BudgetToast({ thresholdPct, limitLabel }: { thresholdPct: number; limitLabel: string }) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/alerts/dismiss", { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Couldn't dismiss.");
      return;
    }
    setHidden(true);
  }

  if (hidden) return null;
  const atLimit = thresholdPct >= 100;
  const message = atLimit
    ? "You've hit your monthly limit. Paid steps are paused until you raise it."
    : `You've used ${thresholdPct}% of your ${limitLabel} monthly limit.`;

  return (
    <div
      role="status"
      className={`border-b ${atLimit ? "border-red-900 bg-red-950/60" : "border-amber-900 bg-amber-950/60"}`}
    >
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-2 text-sm">
        <p className={atLimit ? "text-red-200" : "text-amber-200"}>{message}</p>
        <div className="flex shrink-0 items-center gap-3">
          {error && <span className="text-red-400">{error}</span>}
          <Link href="/settings" className="underline hover:text-zinc-100">
            Settings
          </Link>
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      </div>
    </div>
  );
}
