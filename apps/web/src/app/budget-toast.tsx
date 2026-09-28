"use client";
import Link from "next/link";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/** §7.1 step 7: the highest open budget alert, shown under the header until dismissed. */
export function BudgetToast({ thresholdPct, limitLabel }: { thresholdPct: number; limitLabel: string }) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setBusy(true);
    setError(null);
    const out = await postJson("/api/alerts/dismiss", {});
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
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
      <div className="flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm md:px-10">
        <p className={atLimit ? "text-red-200" : "text-amber-200"}>{message}</p>
        <div className="flex shrink-0 items-center gap-3">
          {error && (
            <span role="alert" className="text-red-300">
              {error}
            </span>
          )}
          <Link href="/settings" className="inline-flex min-h-11 items-center underline hover:text-zinc-100 md:min-h-8">
            Settings
          </Link>
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            className="min-h-11 rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 md:min-h-8"
          >
            {busy ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      </div>
    </div>
  );
}
