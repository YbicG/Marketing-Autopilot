"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

export interface OpenSlotView {
  slotId: string;
  day: number;
  date: string;
  platformName: string;
  label: string;
  priceMicros: number;
  available: boolean;
}

const usd = (m: number) => (m > 0 && m < 10_000 ? `$${(m / 1e6).toFixed(4)}` : `$${(m / 1e6).toFixed(2)}`);

/** "Open · Make more ~$0.40" (§2.3, D12): open slots are shown, never silently filled. */
export function OpenSlots({ slug, campaignId, slots }: { slug: string; campaignId: string; slots: OpenSlotView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; overLimit: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const fillable = slots.filter((s) => s.available);
  const shown = showAll ? slots : slots.slice(0, 6);

  async function fill(ids: string[], key: string) {
    setBusy(key);
    setError(null);
    const out = await postJson<{ runId?: string; error?: string; code?: string }>(`/api/products/${encodeURIComponent(slug)}/refill`, { campaignId, slotIds: ids });
    setBusy(null);
    if (!out.ok) {
      setError({ text: out.error, overLimit: /limit/i.test(out.error) });
      return;
    }
    router.refresh();
  }

  if (!slots.length) return null;
  const total = fillable.reduce((n, s) => n + s.priceMicros, 0);
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((s) => (
          <li key={s.slotId} className="flex items-center justify-between gap-2 rounded-md border border-dashed border-zinc-700 px-3 py-2 text-sm">
            <span className="text-zinc-400">
              Day {s.day} · {s.platformName}
            </span>
            {s.available ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void fill([s.slotId], s.slotId)}
                className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-200 hover:border-zinc-400 disabled:opacity-60"
              >
                {busy === s.slotId ? "Starting…" : s.label}
              </button>
            ) : (
              <span className="text-xs text-zinc-600">{s.label}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {slots.length > 6 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-zinc-400 underline underline-offset-2">
            {showAll ? "Show fewer" : `Show all ${slots.length} open`}
          </button>
        )}
        {fillable.length > 1 && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void fill(fillable.map((s) => s.slotId), "all")}
            className="rounded-md border border-zinc-600 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-400 disabled:opacity-60"
          >
            {busy === "all" ? "Starting…" : `Fill all ${fillable.length} · ~${usd(total)}`}
          </button>
        )}
      </div>
      {error && (
        <p className="text-sm text-red-400">
          {error.text}{" "}
          {error.overLimit && (
            <Link href="/settings" className="underline underline-offset-2">
              Raise limit
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
