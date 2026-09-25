"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

const btn = "rounded-md border border-zinc-600 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-400 disabled:opacity-50";

/** Per-angle actions on the Results page: make more, stop or start, and the (later) ad button. */
export function AngleActions({
  slug,
  angleId,
  status,
  moreCount,
  morePrice,
  canTurnIntoAd,
  adReason,
}: {
  slug: string;
  angleId: string;
  status: "active" | "stopped";
  moreCount: number;
  morePrice: string;
  canTurnIntoAd: boolean;
  adReason: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"more" | "stop" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const base = `/api/results/${encodeURIComponent(slug)}`;

  async function more() {
    setBusy("more");
    setMsg(null);
    const out = await postJson<{ count: number }>(`${base}/more`, { angleId });
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    setMsg({ tone: "ok", text: `Making ${out.data.count} more. They show up in Content for you to approve.` });
    router.refresh();
  }

  async function toggle() {
    setBusy("stop");
    setMsg(null);
    const out = await postJson(`${base}/stop`, { angleId, ...(status === "stopped" ? { status: "active" } : {}) });
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    router.refresh();
  }

  const noMore = moreCount === 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void more()}
          disabled={busy !== null || status === "stopped" || noMore}
          title={status === "stopped" ? "Start this angle again first" : noMore ? "The plan has no open days left for new posts" : undefined}
          className={btn}
        >
          {busy === "more" ? "Starting…" : `Make ${moreCount || 5} more · ~${morePrice}`}
        </button>
        <button type="button" onClick={() => void toggle()} disabled={busy !== null} className={btn}>
          {busy === "stop" ? "Saving…" : status === "stopped" ? "Start this angle again" : "Stop this angle"}
        </button>
        <button
          type="button"
          disabled={!canTurnIntoAd || busy !== null}
          onClick={() => setMsg({ tone: "ok", text: "Ads come in a later update." })}
          title={canTurnIntoAd ? "Ads come in a later update" : adReason}
          className={btn}
        >
          Turn into an ad
        </button>
      </div>
      {!canTurnIntoAd && adReason && <p className="text-xs text-zinc-500">Turn into an ad: {adReason}</p>}
      {msg && <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-400" : "text-amber-300"}`}>{msg.text}</p>}
    </div>
  );
}
