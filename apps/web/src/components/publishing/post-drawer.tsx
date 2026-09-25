"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { postJson } from "@/lib/post-json";
import { CopyButton } from "./copy-button";
import { DownloadPost } from "./download-post";
import { CANCELABLE_STATES, MOVABLE_STATES, platformName, stateName, STATE_TONE } from "./labels";
import { RescheduleForm } from "./reschedule-form";
import { TikTokComposer } from "./tiktok-composer";
import type { PostDetailJson } from "./types";

/** The Queue / Today post drawer: preview, settings, approve, move, cancel, post it yourself. */
export function PostDrawer({ postId, onClose }: { postId: string; onClose: () => void }) {
  const router = useRouter();
  const [post, setPost] = useState<PostDetailJson | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/posts/${postId}`);
      const j = (await res.json()) as PostDetailJson & { error?: string };
      if (!res.ok) setLoadError(j.error ?? "Couldn't open this post.");
      else setPost(j);
    } catch {
      setLoadError("Couldn't reach the server. Check your connection and try again.");
    }
  }, [postId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changed = useCallback(async () => {
    await load();
    router.refresh();
  }, [load, router]);

  async function act(key: string, url: string, body: unknown, ok?: (d: Record<string, unknown>) => string | null) {
    setBusy(key);
    setError(null);
    setNote(null);
    const out = await postJson(url, body);
    setBusy(null);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setNote(ok?.(out.data) ?? null);
    await changed();
  }

  const btn = "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50";
  const primary = "rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose} role="presentation">
      <aside
        className="flex h-full w-full max-w-lg flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Post"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            {post ? (
              <>
                <h2 className="text-lg font-semibold">
                  {platformName(post.platform)}
                  {post.connection?.handle ? <span className="text-zinc-400"> · @{post.connection.handle.replace(/^@/, "")}</span> : null}
                </h2>
                <p className="text-sm text-zinc-400">{post.slot}</p>
              </>
            ) : (
              <h2 className="text-lg font-semibold">Post</h2>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200" aria-label="Close">
            Close
          </button>
        </div>

        {loadError && <p className="text-sm text-red-400">{loadError}</p>}
        {!post && !loadError && <p className="text-sm text-zinc-500">Loading…</p>}

        {post && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-xs ${STATE_TONE[post.state] ?? "border-zinc-700"}`}>{stateName(post.state)}</span>
              {post.approvedAt && <span className="text-xs text-zinc-500">Approved</span>}
            </div>

            {post.conflicts.length > 0 && (
              <ul className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                {post.conflicts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            {post.staleReason && <p className="text-sm text-amber-300">Needs a fresh approval: {post.staleReason}</p>}
            {post.lastError && ["failed", "unknown"].includes(post.state) && <p className="text-sm text-red-300">{post.lastError}</p>}
            {post.platformUrl && (
              <a href={post.platformUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-2">
                Open the live post
              </a>
            )}

            <section className="flex flex-col gap-2">
              {post.text.title && <p className="font-medium">{post.text.title}</p>}
              <p className="whitespace-pre-wrap text-sm text-zinc-200">{post.text.text || "(no text)"}</p>
              {(post.text.parts?.length ?? 0) > 1 && (
                <ol className="flex flex-col gap-2 border-l border-zinc-800 pl-3 text-sm text-zinc-300">
                  {post.text.parts!.slice(1).map((p, i) => (
                    <li key={i} className="whitespace-pre-wrap">
                      {p}
                    </li>
                  ))}
                </ol>
              )}
              {post.media.length > 0 && (
                <div className="flex gap-2 overflow-x-auto">
                  {post.media.map((m) =>
                    m.mime.startsWith("video/") ? (
                      <video key={m.assetId} src={`/api/media/${m.assetId}`} controls className="h-48 rounded border border-zinc-800" />
                    ) : m.mime.startsWith("image/") ? (
                      <img key={m.assetId} src={`/api/media/${m.assetId}?v=preview`} alt="" className="h-32 rounded border border-zinc-800" />
                    ) : (
                      <span key={m.assetId} className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400">
                        {m.filename}
                      </span>
                    ),
                  )}
                </div>
              )}
            </section>

            {post.platform === "tiktok" && post.canAutoPost && ["draft", "pending_approval", "approved", "queued", "paused", "missed", "failed"].includes(post.state) && (
              <TikTokComposer key={`${post.id}-${post.state}`} post={post} onSaved={() => void changed()} />
            )}

            <section className="flex flex-col gap-3" aria-label="Actions">
              {post.state === "pending_approval" && post.canAutoPost && (
                <button
                  type="button"
                  disabled={!!busy}
                  className={primary}
                  onClick={() =>
                    void act("approve", "/api/approvals/posts", { postIds: [post.id] }, (d) => {
                      const skipped = d.skipped as { reason: string }[] | undefined;
                      return skipped?.length ? `Not approved: ${skipped.map((s) => s.reason).join(" ")}` : "Approved. It will go out at its time.";
                    })
                  }
                >
                  {busy === "approve" ? "Approving…" : "Approve to post"}
                </button>
              )}

              {post.state === "missed" && (
                <div className="flex flex-col gap-2 rounded-md border border-red-900/60 p-3">
                  <p className="text-sm text-zinc-300">This post missed its slot while the server was down. Post it now or pick a new time.</p>
                  <button type="button" disabled={!!busy} className={primary} onClick={() => void act("now", `/api/posts/${post.id}/post-now`, {}, () => "Posting it now.")}>
                    {busy === "now" ? "Starting…" : "Post now"}
                  </button>
                  <RescheduleForm postId={post.id} day={post.day} time={post.time} onDone={() => void changed()} />
                </div>
              )}

              {post.state === "awaiting_user" && (
                <div className="flex flex-col gap-2 rounded-md border border-amber-900/60 p-3">
                  <p className="text-sm text-zinc-300">It&apos;s waiting in your TikTok drafts. Open the TikTok app, finish the post, then mark it done here.</p>
                  <CopyButton text={post.text.text} label="Copy caption" className={btn} />
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="url"
                      value={draftUrl}
                      onChange={(e) => setDraftUrl(e.target.value)}
                      placeholder="Link to the live post (optional)"
                      aria-label="Link to the live post"
                      className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
                    />
                    <button
                      type="button"
                      disabled={!!busy}
                      className={primary}
                      onClick={() => void act("done", `/api/posts/${post.id}/manual-done`, draftUrl.trim() ? { url: draftUrl.trim() } : {}, () => "Marked as posted.")}
                    >
                      Mark as done
                    </button>
                  </div>
                </div>
              )}

              {MOVABLE_STATES.has(post.state) && post.state !== "missed" && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-zinc-500">Move it (your time zone)</p>
                  <RescheduleForm postId={post.id} day={post.day} time={post.time} onDone={() => void changed()} label="Move" />
                </div>
              )}

              {!post.canAutoPost && !["published", "canceled", "submitting", "submitted", "unknown", "awaiting_user"].includes(post.state) && (
                <DownloadPost post={post} onDone={() => void changed()} />
              )}
              {post.canAutoPost && post.state === "failed" && <DownloadPost post={post} onDone={() => void changed()} />}

              <div className="flex flex-wrap gap-2">
                {["approved", "queued", "paused", "missed"].includes(post.state) && (
                  <button
                    type="button"
                    disabled={!!busy}
                    className={btn}
                    onClick={() => void act("void", "/api/approvals/void", { postId: post.id, reason: "You took the approval back" }, () => "Approval taken back. It won't go out until you approve it again.")}
                  >
                    Take approval back
                  </button>
                )}
                {CANCELABLE_STATES.has(post.state) && (
                  <button type="button" disabled={!!busy} className={`${btn} text-red-300`} onClick={() => void act("cancel", `/api/posts/${post.id}/cancel`, {}, () => "Canceled.")}>
                    {busy === "cancel" ? "Canceling…" : "Cancel this post"}
                  </button>
                )}
              </div>
              {note && <p className="text-sm text-zinc-300">{note}</p>}
              {error && <p className="text-sm text-red-400">{error}</p>}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}
