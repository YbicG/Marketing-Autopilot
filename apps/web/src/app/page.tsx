import Link from "next/link";
import { redirect } from "next/navigation";
import { listRuns } from "@mkt/core/runs";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "./header";
import { PasteForm } from "./paste-form";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  completed: "Done",
  failed: "Failed",
};

export default async function Home() {
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  if (!ws.onboardedAt) redirect("/welcome");
  const runs = await listRuns(db, s.workspaceId);

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <main className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-10">
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">What are we marketing?</h1>
          <PasteForm />
        </section>

        {runs.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-zinc-400">Recent</h2>
            <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
              {runs.map((r) => (
                <li key={r.id}>
                  <Link href={`/runs/${r.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-zinc-900">
                    <span className="truncate">{String(r.input.url ?? "")}</span>
                    <span className="ml-4 shrink-0 text-sm text-zinc-500">{STATUS_LABEL[r.status] ?? r.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
