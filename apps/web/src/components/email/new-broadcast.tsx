"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/** "Write the seasonal email · ~$0.06": creates the draft and opens it while Claude writes. */
export function NewBroadcast({ slug, priceLabel, disabled }: { slug: string; priceLabel: string; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    const out = await postJson<{ broadcastId?: string }>("/api/email/broadcasts", { slug });
    if (!out.ok || !out.data.broadcastId) {
      setBusy(false);
      setError(out.ok ? "Couldn't start. Try again." : out.error);
      return;
    }
    router.push(`/p/${encodeURIComponent(slug)}/email/${out.data.broadcastId}`);
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy || disabled}
        className="min-h-11 md:min-h-9 self-start rounded-lg bg-accent-strong px-3 py-2 text-sm font-medium text-zinc-50 hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? "Starting…" : `Write the seasonal email · ~${priceLabel}`}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
