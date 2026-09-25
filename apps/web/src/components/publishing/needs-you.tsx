"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";
import { PostDrawer } from "./post-drawer";
import type { NeedsYouJson } from "./types";

/**
 * Needs you (§2.2, §4.3): missed slots (Post now / Reschedule), failed posts with the plain reason,
 * TikTok drafts to finish, and accounts to reconnect.
 */
export function NeedsYouList({ items, empty }: { items: NeedsYouJson[]; empty?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function postNow(postId: string) {
    setBusy(postId);
    setError(null);
    const out = await postJson(`/api/posts/${postId}/post-now`, {});
    setBusy(null);
    if (!out.ok) setError(out.error);
    else router.refresh();
  }

  if (!items.length) return empty ? <p className="text-sm text-zinc-500">{empty}</p> : null;
  const btn = "rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-50";
  return (
    <>
      <ul className="flex flex-col divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {items.map((it, i) => (
          <li key={`${it.kind}-${it.postId ?? it.connectionId ?? i}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <p className={`text-sm ${it.kind === "failed" || it.kind === "missed" ? "text-red-200" : "text-zinc-200"}`}>{it.message}</p>
            <div className="flex gap-2">
              {it.kind === "missed" && it.postId && (
                <>
                  <button type="button" className={btn} disabled={busy === it.postId} onClick={() => void postNow(it.postId!)}>
                    {busy === it.postId ? "Starting…" : "Post now"}
                  </button>
                  <button type="button" className={btn} onClick={() => setOpen(it.postId!)}>
                    Reschedule
                  </button>
                </>
              )}
              {(it.kind === "failed" || it.kind === "finish_in_app" || it.kind === "approve") && it.postId && (
                <button type="button" className={btn} onClick={() => setOpen(it.postId!)}>
                  {it.kind === "finish_in_app" ? "Mark as done" : "Open"}
                </button>
              )}
              {it.kind === "reconnect" && (
                <Link href="/settings/accounts" className={btn}>
                  Reconnect
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {open && <PostDrawer postId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
