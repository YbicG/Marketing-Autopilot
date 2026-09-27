import type { KitAssistedTask } from "@mkt/core/launch";
import type { AssistedCard } from "@mkt/core/publishing";
import { CopyOpenList } from "@/components/publishing/copy-open";

/** "reddit/college" → "r/college" for the card title (the deep link and rules link are already built). */
const displayVenue = (v: string) => (v.startsWith("reddit/") ? `r/${v.slice("reddit/".length)}` : v);

/**
 * The subreddit drafts as Copy & open tasks (§5.8 step 9): rules summary, Open rules page, the
 * required "I checked the rules today" tick, then Copy title → Open posting page → Copy body →
 * Mark as posted. We never post to Reddit.
 */
export function SubredditTasks({ open, all }: { open: AssistedCard[]; all: KitAssistedTask[] }) {
  const done = all.filter((t) => t.status === "done");
  return (
    <section className="flex flex-col gap-3" aria-label="Copy and open">
      <div>
        <h2 className="text-lg font-semibold">Post them yourself</h2>
        <p className="text-sm text-zinc-400">
          Reddit doesn&apos;t allow posting from apps like this one, so each draft is a Copy &amp; open task. Read their rules first; many college communities
          don&apos;t allow self-promotion at all.
        </p>
      </div>
      {open.length === 0 && done.length === 0 && (
        <p className="text-sm text-zinc-500">No tasks yet. They appear once a draft passes its checks and is saved.</p>
      )}
      <CopyOpenList tasks={open.map((t) => ({ ...t, venue: displayVenue(t.venue) }))} />
      {done.length > 0 && (
        <div className="text-sm">
          <p className="text-zinc-400">Posted</p>
          <ul className="mt-1 flex flex-col gap-1">
            {done.map((t) => (
              <li key={t.id} className="text-zinc-300">
                {displayVenue(t.venue)}
                {t.postedUrl && (
                  <>
                    {" · "}
                    <a href={t.postedUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                      See the post
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
