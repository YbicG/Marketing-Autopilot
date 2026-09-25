"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/** Regenerate profile · Export brief · Make my campaign (M2). */
export function PlanActions({ slug, hasProfile }: { slug: string; hasProfile: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/products/${encodeURIComponent(slug)}`;

  async function regenerate() {
    setBusy(true);
    setError(null);
    const out = await postJson<{ runId?: string }>(`${base}/regenerate`, {});
    if (!out.ok || !out.data.runId) {
      setError(out.ok ? "Couldn't start. Try again." : out.error);
      setBusy(false);
      return;
    }
    router.push(`/runs/${out.data.runId}`);
  }

  const secondary = "rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60";
  return (
    <section className="flex flex-col gap-3" aria-label="Next steps">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 opacity-50">
          Make my campaign · ~$7
        </button>
        <button type="button" onClick={() => void regenerate()} disabled={busy || !hasProfile} className={secondary}>
          {busy ? "Starting…" : "Regenerate profile · ~$0.30"}
        </button>
        {hasProfile && (
          <a href={`${base}/brief`} download className={secondary}>
            Export brief
          </a>
        )}
      </div>
      <p className="text-xs text-zinc-500">Coming next: posting (M2). Regenerating keeps anything you pinned or fixed.</p>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
