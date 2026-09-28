import { redirect } from "next/navigation";
import { getWorkspace } from "@mkt/core/tenancy";
import { AppShell } from "@/components/shell/app-shell";
import { NeedsYouGrid, needsYouCards } from "@/components/shell/needs-you-cards";
import { getDb } from "@/lib/db";
import { loadProjects, loadReconnects } from "@/lib/projects";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Every project's waiting items on one page; each card opens the place to fix it. */
export default async function NeedsYouPage() {
  const s = await requireWorkspace();
  const ws = await getWorkspace(getDb(), s.workspaceId);
  if (!ws) redirect("/signin");
  const [projects, reconnects] = await Promise.all([loadProjects(s.workspaceId), loadReconnects(s.workspaceId)]);
  const cards = needsYouCards(projects, reconnects);

  return (
    <AppShell workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} userName={s.name}>
      <main className="flex max-w-6xl flex-col gap-8 px-4 py-10 md:px-10">
        <header>
          <h1 className="font-serif text-4xl tracking-tight">Needs you</h1>
          <p className="mt-1 text-muted">
            {cards.length ? "Things only you can do. Everything else is running on its own." : "Nothing is waiting on you. Posts are going out on their own."}
          </p>
        </header>
        {cards.length > 0 && <NeedsYouGrid cards={cards} />}
      </main>
    </AppShell>
  );
}
