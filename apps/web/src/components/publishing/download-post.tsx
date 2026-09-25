"use client";
import { useState } from "react";
import { postJson } from "@/lib/post-json";
import { CopyButton } from "./copy-button";
import { platformName } from "./labels";
import type { PostDetailJson } from "./types";

/**
 * "Download & post yourself" (§2.3, §5.8 step 10): shown when no publisher can post this for us.
 * Download the platform-ready file(s), copy the caption, post it, paste the link, Mark as posted.
 */
export function DownloadPost({ post, onDone }: { post: PostDetailJson; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const caption = [post.text.title, post.text.text, ...(post.text.parts?.slice(1) ?? [])].filter(Boolean).join("\n\n");
  const files = post.media.length;

  async function done() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/posts/${post.id}/manual-done`, { url });
    setBusy(false);
    if (!out.ok) setError(out.error);
    else onDone();
  }

  const step = "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500";
  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-800 p-3" aria-label="Download and post yourself">
      <div>
        <h3 className="text-sm font-medium">Download &amp; post yourself</h3>
        <p className="text-xs text-zinc-500">
          {post.connection
            ? `Your ${platformName(post.platform)} account isn't connected for posting.`
            : `No ${platformName(post.platform)} account is connected, so we can't post this for you.`}{" "}
          Post it by hand, then paste the link so we can track it.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {files > 0 && (
          <a href={`/api/posts/${post.id}/download`} download className={step}>
            {files === 1 ? `Download ${post.media[0]!.filename}` : `Download ${files} files (zip)`}
          </a>
        )}
        <CopyButton text={caption} label="Copy caption" className={step} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Link to your live post"
          aria-label="Link to your live post"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => void done()}
          disabled={busy || !url.trim()}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          Mark as posted
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
