"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

const primary = "min-h-11 rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50 md:min-h-0";
const quiet = "min-h-11 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50 md:min-h-0";

/** Accept or reject one suggested profile change. */
export function DnaChangeButtons({ slug, id }: { slug: string; id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "accept" | "reject") {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/products/${encodeURIComponent(slug)}/dna-changes`, { action, id });
    setBusy(false);
    if (!out.ok) setError(out.error);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void decide("accept")} disabled={busy} className={primary}>
        Accept
      </button>
      <button type="button" onClick={() => void decide("reject")} disabled={busy} className={quiet}>
        Reject
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
