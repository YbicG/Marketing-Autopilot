"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AssistedCard } from "@mkt/core/publishing";
import { postJson } from "@/lib/post-json";
import { CopyButton } from "./copy-button";
import { platformName } from "./labels";

/**
 * Copy & open (§2.3, §5.8 step 9): venues we never post to ourselves. The person reads the rules,
 * ticks "I checked the rules today", then Copy title → Open posting page → Copy body → Mark as posted.
 */
export function CopyOpenList({ tasks }: { tasks: AssistedCard[] }) {
  if (!tasks.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {tasks.map((t) => (
        <CopyOpenCard key={t.id} task={t} />
      ))}
    </div>
  );
}

function CopyOpenCard({ task }: { task: AssistedCard }) {
  const router = useRouter();
  const [checked, setChecked] = useState(task.rulesCheckedToday);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsRules = !!(task.rulesUrl || task.rulesSnapshot);
  const ready = !needsRules || checked;

  async function tick() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/assisted/${task.id}/rules-checked`, {});
    setBusy(false);
    if (!out.ok) setError(out.error);
    else setChecked(true);
  }

  async function posted() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/assisted/${task.id}/posted`, { url });
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    router.refresh();
  }

  const step = "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500";
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">
          {platformName(task.venue)}
          {task.title ? <span className="text-zinc-400"> · {task.title}</span> : null}
        </h3>
        {task.due && <span className="text-xs text-zinc-500">Due {task.due}</span>}
      </header>

      {needsRules && (
        <section className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3 text-sm">
          <p className="text-xs text-zinc-500">
            Their rules{task.rulesFetched ? `, as we read them on ${task.rulesFetched}` : ""}. Rules change, so read the real page before posting.
          </p>
          {task.rulesSnapshot && <p className="whitespace-pre-wrap text-zinc-300">{task.rulesSnapshot}</p>}
          <div className="flex flex-wrap items-center gap-3">
            {task.rulesUrl && (
              <a href={task.rulesUrl} target="_blank" rel="noopener noreferrer" className={step}>
                Open rules page
              </a>
            )}
            <label className="flex items-center gap-2 text-zinc-200">
              <input type="checkbox" checked={checked} disabled={checked || busy} onChange={() => void tick()} />I checked the rules today
            </label>
          </div>
        </section>
      )}

      <ol className={`flex flex-wrap items-center gap-2 ${ready ? "" : "pointer-events-none opacity-40"}`} aria-disabled={!ready}>
        {task.title && (
          <li>
            <CopyButton text={task.title} label="1. Copy title" className={step} />
          </li>
        )}
        <li>
          {task.postingUrl ? (
            <a href={task.postingUrl} target="_blank" rel="noopener noreferrer" className={step}>
              {task.title ? "2." : "1."} Open posting page
            </a>
          ) : (
            <span className="text-xs text-zinc-500">Open {platformName(task.venue)} and start a new post.</span>
          )}
        </li>
        <li>
          <CopyButton text={task.body} label={`${task.title ? "3." : "2."} Copy body`} className={step} />
        </li>
      </ol>
      <details className="text-sm text-zinc-400">
        <summary className="cursor-pointer">Show the text</summary>
        <p className="mt-2 whitespace-pre-wrap text-zinc-300">{task.body}</p>
      </details>

      <div className={`flex flex-wrap items-center gap-2 ${ready ? "" : "opacity-40"}`}>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Link to your live post"
          aria-label="Link to your live post"
          disabled={!ready}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => void posted()}
          disabled={!ready || busy || !url.trim()}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          Mark as posted
        </button>
      </div>
      {!ready && <p className="text-xs text-amber-300">Open their rules and tick &quot;I checked the rules today&quot; first.</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </article>
  );
}
