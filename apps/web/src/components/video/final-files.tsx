"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AiLabelChip, IssueList, PLATFORM_NAME, POST_STATE_LABEL } from "@/components/content/status";
import { postJson } from "@/lib/post-json";

type Issue = { severity: "block" | "warn"; message: string; code?: string };

export interface FinalRender {
  id: string;
  hookIdx: number;
  status: string;
  error: string | null;
  attempts: number;
  issues: Issue[];
  fixes: string[];
  loudness: { lufs: number; truePeak: number } | null;
  outputAssetId: string | null;
  contactSheetAssetId: string | null;
  thumbAssetId: string | null;
  files: Record<string, string>;
}

export interface FinalFile {
  variantId: string;
  platform: string;
  hookIdx: number | null;
  format: string;
  videoAssetId: string | null;
  thumbAssetId: string | null;
  aiLabel: boolean;
  tier: string;
  rank: number | null;
  issues: Issue[];
}

export interface FinalPost {
  id: string;
  variantId: string;
  platform: string;
  state: string;
  when: string;
}

const FILE_LABEL: Record<string, string> = {
  tiktok: "TikTok file",
  ig_reel: "Instagram Reel file",
  yt_short: "YouTube Shorts file",
  x: "X file",
  master: "Master file",
};

const RENDER_STATUS: Record<string, string> = {
  queued: "Waiting its turn",
  rendering: "Rendering",
  qa: "Checking it",
  succeeded: "Done",
  failed: "Failed",
};

const tierOf = (t: string): "A" | "B" | "C" => (t === "B" || t === "C" ? t : "A");

/** Loudness in plain words: platforms play at about −14 LUFS. */
function loudnessNote(l: { lufs: number; truePeak: number }): string {
  const ok = Math.abs(l.lufs + 14) <= 1 && l.truePeak <= -1;
  return `${ok ? "Loudness is right" : "Loudness is off"} (${l.lufs.toFixed(1)} LUFS, peak ${l.truePeak.toFixed(1)} dB)`;
}

/** Gate 2 (D16): the 3 finished versions, their checks and files, and "Approve to post". */
export function FinalFiles({
  itemId,
  slug,
  status,
  tier,
  judgeIssues,
  openingLines,
  renders,
  files,
  posts,
}: {
  itemId: string;
  slug: string;
  status: string;
  tier: string;
  judgeIssues: Issue[];
  openingLines: string[];
  renders: FinalRender[];
  files: FinalFile[];
  posts: FinalPost[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const ready = status === "final_ready" || status === "approved";
  const pending = posts.filter((p) => p.state === "pending_approval");
  const blocked = files.some((f) => f.issues.some((i) => i.severity === "block")) || renders.some((r) => r.issues.some((i) => i.severity === "block"));

  async function approve() {
    setBusy(true);
    setMsg(null);
    const made = await postJson<{ postIds: string[]; unscheduled: string[] }>(`/api/videos/${itemId}/posts`, {});
    if (!made.ok) {
      setBusy(false);
      return setMsg({ tone: "err", text: made.error });
    }
    const { postIds, unscheduled } = made.data;
    const missing = unscheduled.length ? ` ${unscheduled.map((p) => PLATFORM_NAME[p] ?? p).join(", ")} has no day in the plan, so it wasn't scheduled.` : "";
    if (!postIds.length) {
      setBusy(false);
      router.refresh();
      return setMsg({ tone: "err", text: `Nothing is waiting for approval.${missing}` });
    }
    const out = await postJson<{ approved?: number; skipped?: { postId: string; reason: string }[] }>("/api/approvals/posts", { postIds });
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    const skipped = out.data.skipped ?? [];
    setMsg({
      tone: skipped.length || missing ? "err" : "ok",
      text: `${out.data.approved ?? 0} approved to post.${skipped.length ? ` ${skipped.length} not: ${[...new Set(skipped.map((x) => x.reason))].join("; ")}` : ""}${missing}`,
    });
    router.refresh();
  }

  const byHook = [...renders].sort((a, b) => a.hookIdx - b.hookIdx);
  return (
    <section className="flex flex-col gap-4 rounded-md border border-zinc-800 p-4" aria-label="Final versions">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold">Final versions</h3>
          <AiLabelChip tier={tierOf(tier)} />
        </div>
        {ready && (
          <span className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void approve()}
              disabled={busy || blocked}
              title={blocked ? "Fix the problems marked “Must fix” first" : undefined}
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? "Approving…" : pending.length || !posts.length ? "Approve to post" : "Approve any new files"}
            </button>
            <a href={`/p/${encodeURIComponent(slug)}/queue`} className="text-sm text-zinc-400 underline underline-offset-2">
              See it in the Queue
            </a>
          </span>
        )}
      </div>
      {msg && <p className={`text-sm ${msg.tone === "ok" ? "text-emerald-400" : "text-amber-300"}`}>{msg.text}</p>}
      {judgeIssues.length > 0 && <IssueList issues={judgeIssues} />}

      <ol className="grid gap-4 md:grid-cols-3">
        {byHook.map((r) => {
          const mine = files.filter((f) => f.hookIdx === r.hookIdx);
          const rank = mine.find((f) => f.rank !== null)?.rank ?? null;
          return (
            <li key={r.id} className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-sm font-medium">Version {r.hookIdx + 1}</h4>
                <span className="text-xs text-zinc-500">{rank ? `Ranked #${rank}` : (RENDER_STATUS[r.status] ?? r.status)}</span>
              </div>
              <p className="text-xs text-zinc-400">“{openingLines[r.hookIdx] ?? ""}”</p>
              {r.outputAssetId ? (
                <video src={`/api/media/${r.outputAssetId}`} controls preload="metadata" className="w-full rounded bg-black" {...(r.thumbAssetId ? { poster: `/api/media/${r.thumbAssetId}` } : {})} />
              ) : (
                <div className="flex aspect-[9/16] items-center justify-center rounded bg-zinc-900 text-xs text-zinc-500">{RENDER_STATUS[r.status] ?? r.status}…</div>
              )}
              {r.error && <p className="text-xs text-red-400">{r.error}</p>}
              {r.loudness && <p className="text-xs text-zinc-500">{loudnessNote(r.loudness)}</p>}
              {r.fixes.length > 0 && <p className="text-xs text-zinc-500">Fixed for you: {r.fixes.join("; ")}</p>}
              {r.status === "succeeded" && <IssueList issues={r.issues} />}
              {r.contactSheetAssetId && (
                <details className="text-xs text-zinc-400">
                  <summary className="cursor-pointer">Frames at a glance</summary>
                  <img src={`/api/media/${r.contactSheetAssetId}`} alt="Nine frames from this version" className="mt-2 w-full rounded" loading="lazy" />
                </details>
              )}
              {mine.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs">
                  {mine.map((f) => {
                    const post = posts.find((p) => p.variantId === f.variantId);
                    return (
                      <li key={f.variantId} className="flex flex-col gap-0.5 border-t border-zinc-800 pt-1">
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-zinc-300">{PLATFORM_NAME[f.platform] ?? f.platform}</span>
                          {f.videoAssetId && (
                            <a href={`/api/media/${f.videoAssetId}?dl=1`} download={`${f.platform}-version-${r.hookIdx + 1}.mp4`} className="text-zinc-400 underline underline-offset-2">
                              Download {FILE_LABEL[f.format] ?? "file"}
                            </a>
                          )}
                        </span>
                        {post && (
                          <span className="text-zinc-500">
                            {POST_STATE_LABEL[post.state] ?? post.state} · {post.when}
                          </span>
                        )}
                        {f.issues.filter((i) => i.severity === "block").map((i, k) => (
                          <span key={k} className="text-red-400">
                            Must fix: {i.message}
                          </span>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
