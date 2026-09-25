"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/**
 * Approve from an editor. Approval routes belong to the Queue (W2): POST /api/approvals/posts
 * {postIds} → {approved, skipped:[{postId, reason}]}. Only ever a UI click (D9).
 */
export function ApproveButton({ slug, postIds, label }: { slug: string; postIds: string[]; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function approve() {
    setBusy(true);
    setMsg(null);
    const out = await postJson<{ approved?: number; skipped?: { postId: string; reason: string }[] }>("/api/approvals/posts", { postIds });
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    const skipped = out.data.skipped ?? [];
    const n = out.data.approved ?? 0;
    setMsg({
      tone: skipped.length ? "err" : "ok",
      text: `${n} approved.${skipped.length ? ` ${skipped.length} not: ${[...new Set(skipped.map((x) => x.reason))].join("; ")}` : ""}`,
    });
    router.refresh();
  }

  if (!postIds.length) {
    return (
      <Link href={`/p/${encodeURIComponent(slug)}/queue`} className="text-sm text-zinc-400 underline underline-offset-2">
        Open the Queue
      </Link>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void approve()}
        disabled={busy}
        className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
      >
        {busy ? "Approving…" : label}
      </button>
      {msg && <span className={`text-xs ${msg.tone === "ok" ? "text-emerald-400" : "text-amber-300"}`}>{msg.text}</span>}
    </span>
  );
}
