import Link from "next/link";
import { redirect } from "next/navigation";
import { listRuns } from "@mkt/core/runs";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { DropZone } from "./drop-zone";
import { Header } from "./header";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  completed: "Done",
  failed: "Failed",
};

const KIND_LABEL: Record<string, string> = {
  m0_summary: "Quick read",
  ingest: "Reading your product",
  strategy: "Picking angles",
  dna_regenerate: "Rewriting profile",
};

type Run = Awaited<ReturnType<typeof listRuns>>[number];

function runTitle(r: Run): string {
  const input = r.input as { url?: unknown; links?: unknown; slug?: unknown };
  if (typeof input.url === "string") return input.url;
  if (Array.isArray(input.links) && typeof input.links[0] === "string") return input.links.join(", ");
  if (typeof input.slug === "string") return input.slug;
  return KIND_LABEL[r.kind] ?? "Run";
}

export default async function Home() {
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  if (!ws.onboardedAt) redirect("/welcome");
  const runs = await listRuns(db, s.workspaceId);
  const slugFor = (r: Run) => (typeof r.input.slug === "string" ? r.input.slug : null);

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <main className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-10">
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">What are we marketing?</h1>
          <DropZone />
        </section>

        {runs.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-zinc-400">Recent</h2>
            <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
              {runs.map((r) => {
                const slug = slugFor(r);
                return (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-900">
                    <Link href={`/runs/${r.id}`} className="min-w-0 flex-1">
                      <span className="block truncate">{runTitle(r)}</span>
                      <span className="text-xs text-zinc-500">{KIND_LABEL[r.kind] ?? r.kind}</span>
                    </Link>
                    {slug && r.status === "completed" && (
                      <Link href={`/p/${slug}/plan`} className="shrink-0 text-sm text-zinc-300 underline-offset-2 hover:underline">
                        Your plan
                      </Link>
                    )}
                    <span className="shrink-0 text-sm text-zinc-500">{STATUS_LABEL[r.status] ?? r.status}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
