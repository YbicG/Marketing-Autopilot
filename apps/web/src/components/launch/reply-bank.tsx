"use client";
import { useMemo, useState } from "react";
import { CopyButton } from "@/components/publishing/copy-button";
import { searchReplies } from "./kit-model";

export interface ReplyRow {
  trigger: string;
  /** The reply as it's pasted: {{link:landing}} already turned into the tracking link. */
  reply: string;
}

/**
 * The reply bank for launch day (§2.3 Launch): type a word from the comment, copy the answer.
 * Nothing is posted from here; you paste each reply yourself.
 */
export function ReplyBank({ replies }: { replies: ReplyRow[] }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => searchReplies(replies, q), [replies, q]);
  return (
    <section className="flex flex-col gap-3" aria-label="Reply bank">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Type a word from the comment, like price or Outlook"
        aria-label="Search the replies"
        className="min-h-11 w-full rounded-md border border-edge bg-zinc-900 px-3 py-2 text-sm text-ink outline-none focus:border-zinc-400 md:min-h-9"
      />
      <p className="text-xs text-zinc-500" aria-live="polite">
        {q ? `${shown.length} of ${replies.length} replies` : `${replies.length} replies`}. Copy one, then paste it where the question was asked.
      </p>
      {shown.length === 0 && <p className="text-sm text-zinc-400">No reply matches. Try another word, or add one below.</p>}
      <ul className="flex flex-col gap-2">
        {shown.map((r, i) => (
          <li key={`${i}-${r.trigger}`} className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-zinc-200">{r.trigger}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-400">{r.reply}</p>
            </div>
            <CopyButton text={r.reply} label="Copy" className="min-h-11 shrink-0 self-start rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 md:min-h-9" />
          </li>
        ))}
      </ul>
    </section>
  );
}
