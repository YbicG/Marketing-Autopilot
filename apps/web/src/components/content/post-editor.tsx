"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { countChars, type RunEvent, type SocialPlatform } from "@mkt/contracts";
import { postJson } from "@/lib/post-json";
import { ApproveButton } from "./approve-button";
import { IssueList, POST_STATE_LABEL } from "./status";

/** Serializable slice of core's PostEditorVariant (client components can't import core). */
export interface EditorVariant {
  id: string;
  platform: SocialPlatform;
  platformLabel: string;
  kind: "post" | "thread" | "bio" | "pinned";
  limit: number;
  text: string;
  parts: string[];
  hashtags: string[];
  firstComment: string | null;
  issues: { severity: "block" | "warn"; message: string; code: string }[];
  posts: { id: string; state: string; when: string; connected: boolean }[];
  lockedReason: string | null;
  lastRewrite: { runId: string; status: string; message: string | null } | null;
}

const caption = (text: string, tags: string[]) => (tags.length ? `${text}\n\n${tags.map((h) => `#${h}`).join(" ")}` : text);
const parseTags = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((h) => h.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean);

/** Post editor (§2.3): platform variants side by side, with character counters and checks. */
export function PostEditor({ slug, variants, rewritePrice }: { slug: string; variants: EditorVariant[]; rewritePrice: string }) {
  const pending = variants.flatMap((v) => v.posts.filter((p) => p.state === "pending_approval").map((p) => p.id));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">Edit any version. Saving an approved post sends it back for approval.</p>
        <span className="flex items-center gap-3">
          <ApproveButton slug={slug} postIds={pending} label={`Approve ${pending.length === 1 ? "it" : `all ${pending.length}`}`} />
          <Link href={`/p/${encodeURIComponent(slug)}/queue`} className="text-sm text-zinc-400 underline underline-offset-2">
            Skip or move it in the Queue
          </Link>
        </span>
      </div>
      <div className={`grid gap-4 ${variants.length > 1 ? "lg:grid-cols-2" : ""}`}>
        {variants.map((v) => (
          // Remount when the saved text changes (a save or a rewrite landed), keeping other columns' edits.
          <VariantColumn key={`${v.id}:${v.text}:${v.parts.join("|")}:${v.hashtags.join(" ")}:${v.firstComment ?? ""}`} slug={slug} v={v} rewritePrice={rewritePrice} />
        ))}
      </div>
    </div>
  );
}

function VariantColumn({ slug, v, rewritePrice }: { slug: string; v: EditorVariant; rewritePrice: string }) {
  const router = useRouter();
  const isThread = v.kind === "thread";
  const [text, setText] = useState(v.text);
  const [parts, setParts] = useState<string[]>(v.parts.length ? v.parts : [v.text]);
  const [tags, setTags] = useState(v.hashtags.map((h) => `#${h}`).join(" "));
  const [firstComment, setFirstComment] = useState(v.firstComment ?? "");
  const [busy, setBusy] = useState<"save" | "rewrite" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const rewriting = v.lastRewrite && (v.lastRewrite.status === "queued" || v.lastRewrite.status === "running") ? v.lastRewrite.runId : null;

  useEffect(() => {
    if (!rewriting) return;
    const es = new EventSource(`/api/runs/${rewriting}/events`);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as RunEvent;
        if (ev.type === "run_completed" || ev.type === "stage_failed") {
          es.close();
          router.refresh();
        }
      } catch {
        // ignore a malformed line
      }
    };
    const t = setInterval(() => router.refresh(), 15_000);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [rewriting, router]);

  const hashtags = useMemo(() => parseTags(tags), [tags]);
  const showTags = v.kind === "post" || v.kind === "thread";
  const counts = isThread
    ? parts.map((p, i) => countChars(v.platform, i === parts.length - 1 ? caption(p, hashtags) : p))
    : [countChars(v.platform, showTags ? caption(text, hashtags) : text)];
  const dirty =
    (isThread ? parts.join("\u0000") !== (v.parts.length ? v.parts : [v.text]).join("\u0000") : text !== v.text) ||
    hashtags.join(" ") !== v.hashtags.join(" ") ||
    (firstComment || null) !== v.firstComment;
  const locked = !!v.lockedReason;

  async function save() {
    setBusy("save");
    setError(null);
    const out = await postJson(`/api/variants/${v.id}`, {
      text: isThread ? (parts[0] ?? "") : text,
      ...(isThread ? { parts } : {}),
      ...(showTags ? { hashtags } : {}),
      ...(v.firstComment !== null || firstComment ? { firstComment: firstComment || null } : {}),
    });
    setBusy(null);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }

  async function rewrite() {
    setBusy("rewrite");
    setError(null);
    const out = await postJson(`/api/variants/${v.id}/rewrite`, ask.trim() ? { ask: ask.trim() } : {});
    setBusy(null);
    if (!out.ok) return setError(out.error);
    setAsk("");
    router.refresh();
  }

  const field = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-400 focus:outline-none disabled:opacity-60";
  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-800 p-4" aria-label={v.platformLabel}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{v.platformLabel}</h2>
        <span className="text-xs text-zinc-500">
          {v.kind === "bio" ? "Profile bio" : v.kind === "pinned" ? "Pinned post" : isThread ? `Thread · ${parts.length} parts` : "Post"} · up to {v.limit}
        </span>
      </div>

      {isThread ? (
        <ol className="flex flex-col gap-2">
          {parts.map((p, i) => (
            <li key={i} className="flex flex-col gap-1">
              <textarea
                value={p}
                onChange={(e) => setParts((xs) => xs.map((x, k) => (k === i ? e.target.value : x)))}
                rows={4}
                disabled={locked}
                aria-label={`Part ${i + 1}`}
                className={field}
              />
              <span className="flex justify-between text-xs">
                <Counter n={counts[i] ?? 0} limit={v.limit} />
                {parts.length > 2 && !locked && (
                  <button type="button" onClick={() => setParts((xs) => xs.filter((_, k) => k !== i))} className="text-zinc-500 hover:text-zinc-300">
                    Remove part
                  </button>
                )}
              </span>
            </li>
          ))}
          {!locked && parts.length < 25 && (
            <button type="button" onClick={() => setParts((xs) => [...xs, ""])} className="self-start text-xs text-zinc-400 underline underline-offset-2">
              Add a part
            </button>
          )}
        </ol>
      ) : (
        <div className="flex flex-col gap-1">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={v.kind === "bio" ? 3 : 7} disabled={locked} aria-label={`${v.platformLabel} text`} className={field} />
          <Counter n={counts[0] ?? 0} limit={v.limit} />
        </div>
      )}

      {showTags && (
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Hashtags
          <input value={tags} onChange={(e) => setTags(e.target.value)} disabled={locked} placeholder="#college #studytok" className={field} />
        </label>
      )}
      {showTags && (v.firstComment !== null || v.platform === "instagram") && (
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          First comment
          <textarea value={firstComment} onChange={(e) => setFirstComment(e.target.value)} rows={2} disabled={locked} className={field} />
        </label>
      )}
      <p className="text-xs text-zinc-500">Links are added for you as a tracking link wherever the text says {"{{link:landing}}"}.</p>

      <IssueList issues={v.issues} />

      {v.lockedReason ? (
        <p className="text-sm text-zinc-400">{v.lockedReason}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy !== null || !dirty}
              className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            {(v.kind === "post" || v.kind === "thread") && (
              <button
                type="button"
                onClick={() => void rewrite()}
                disabled={busy !== null || !!rewriting}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60"
              >
                {rewriting ? "Rewriting…" : busy === "rewrite" ? "Starting…" : `Rewrite for ${v.platformLabel} · ~${rewritePrice}`}
              </button>
            )}
            {dirty && <span className="text-xs text-zinc-500">Not saved yet</span>}
          </div>
          {(v.kind === "post" || v.kind === "thread") && !rewriting && (
            <input value={ask} onChange={(e) => setAsk(e.target.value)} maxLength={500} placeholder="Anything to change? (optional, e.g. shorter, more casual)" className={field} />
          )}
          {v.lastRewrite?.message && !rewriting && <p className="text-xs text-zinc-400">Last rewrite: {v.lastRewrite.message}</p>}
        </div>
      )}
      {error && (
        <p className="text-sm text-red-400">
          {error}{" "}
          {/limit/i.test(error) && (
            <Link href="/settings" className="underline underline-offset-2">
              Raise limit
            </Link>
          )}
        </p>
      )}

      {v.posts.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-zinc-800 pt-2 text-xs text-zinc-500">
          {v.posts.map((p) => (
            <li key={p.id}>
              {p.when} · {POST_STATE_LABEL[p.state] ?? p.state}
              {!p.connected && " · account not connected yet"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Counter({ n, limit }: { n: number; limit: number }) {
  const over = n > limit;
  return (
    <span className={`text-xs ${over ? "text-red-400" : n > limit * 0.9 ? "text-amber-300" : "text-zinc-500"}`} aria-live="polite">
      {n} / {limit}
    </span>
  );
}
