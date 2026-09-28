"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

type Result = { approved: number; skipped: { postId: string; reason: string }[] };

/** Explicit bulk approvals on the Queue (§2.1 principle 2): "Approve next 7 days (14 posts)", "Approve finished videos". */
export function BulkApprove({ slug, nextDays, finishedVideos }: { slug: string; nextDays: number; finishedVideos: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "next-days" | "videos") {
    if (busy) return;
    const ask =
      kind === "next-days"
        ? `Approve ${nextDays} post${nextDays === 1 ? "" : "s"} scheduled in the next 7 days? They go out at their times unless you take the approval back.`
        : `Approve the posts for ${finishedVideos} finished video${finishedVideos === 1 ? "" : "s"}? They go out at their times unless you take the approval back.`;
    if (!window.confirm(ask)) return;
    setBusy(kind);
    setError(null);
    setResult(null);
    const out = await postJson<Result>(`/api/approvals/${kind}`, kind === "next-days" ? { productSlug: slug, days: 7 } : { productSlug: slug });
    setBusy(null);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setResult(out.data);
    router.refresh();
  }

  const btn = "inline-flex min-h-11 items-center rounded-md px-3 py-1.5 text-sm disabled:opacity-50 md:min-h-9";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void run("next-days")}
          disabled={!!busy || nextDays === 0}
          className={`${btn} bg-zinc-100 font-medium text-zinc-900 hover:bg-zinc-50`}
        >
          {busy === "next-days" ? "Approving…" : `Approve next 7 days (${nextDays} post${nextDays === 1 ? "" : "s"})`}
        </button>
        <button
          type="button"
          onClick={() => void run("videos")}
          disabled={!!busy || finishedVideos === 0}
          className={`${btn} border border-zinc-700 text-zinc-200 hover:border-zinc-500`}
        >
          {busy === "videos" ? "Approving…" : `Approve finished videos (${finishedVideos})`}
        </button>
      </div>
      <div aria-live="polite">
        {result && (
          <div className="text-xs text-zinc-400">
            <p>
              Approved {result.approved} post{result.approved === 1 ? "" : "s"}.
              {result.skipped.length ? ` ${result.skipped.length} still need you:` : ""}
            </p>
            {result.skipped.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {[...new Set(result.skipped.map((s) => s.reason))].slice(0, 5).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
