import Link from "next/link";
import type { ProjectSummary } from "@mkt/core/publishing";
import { ProjectTile } from "./tile";

export interface NeedsYouCard {
  key: string;
  project: { slug: string; name: string } | null;
  title: string;
  detail: string;
  href: string;
  action: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything waiting on the user, across projects, most blocking first. */
export function needsYouCards(projects: ProjectSummary[], reconnects: number): NeedsYouCard[] {
  const cards: NeedsYouCard[] = [];
  if (reconnects > 0) {
    cards.push({
      key: "reconnect",
      project: null,
      title: `Reconnect ${plural(reconnects, "account")}`,
      detail: "A social account signed you out. Its posts can't go out until you sign in again.",
      href: "/settings/accounts",
      action: "Reconnect",
    });
  }
  for (const p of projects) {
    if (p.attention > 0) {
      cards.push({
        key: `attention-${p.id}`,
        project: p,
        title: `${plural(p.attention, "post")} need${p.attention === 1 ? "s" : ""} a hand`,
        detail: "Missed a slot, didn't go out, or is waiting in your TikTok drafts.",
        href: `/p/${p.slug}`,
        action: "Sort it out",
      });
    }
  }
  for (const p of projects) {
    if (p.waitingApproval > 0) {
      cards.push({
        key: `approve-${p.id}`,
        project: p,
        title: `Approve ${plural(p.waitingApproval, "post")}`,
        detail: "Nothing goes out until you say so.",
        href: `/p/${p.slug}/queue`,
        action: "Review",
      });
    }
  }
  return cards;
}

export function NeedsYouGrid({ cards }: { cards: NeedsYouCard[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => (
        <li key={c.key} className="flex flex-col gap-3 rounded-2xl border border-warn/25 bg-warn-soft/40 p-4">
          <div className="flex items-center gap-2 text-xs text-muted">
            {c.project ? (
              <>
                <ProjectTile slug={c.project.slug} name={c.project.name} />
                {c.project.name}
              </>
            ) : (
              "All projects"
            )}
          </div>
          <div className="flex-1">
            <p className="font-medium">{c.title}</p>
            <p className="mt-1 text-sm text-muted">{c.detail}</p>
          </div>
          <Link href={c.href} className="self-start rounded-lg bg-warn px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-warn/90">
            {c.action}
          </Link>
        </li>
      ))}
    </ul>
  );
}
