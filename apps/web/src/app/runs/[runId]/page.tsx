import { notFound, redirect } from "next/navigation";
import { ProductSummary } from "@mkt/contracts";
import { getRun } from "@mkt/core/runs";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../header";
import { LiveFeed } from "./live-feed";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const [ws, run] = await Promise.all([getWorkspace(db, s.workspaceId), getRun(db, s.workspaceId, runId)]);
  if (!ws) redirect("/signin");
  if (!run) notFound();

  const parsed = ProductSummary.safeParse((run.result as { summary?: unknown } | null)?.summary);
  const summary = run.status === "completed" && parsed.success ? parsed.data : null;

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10">
        <div>
          <p className="text-sm text-zinc-500">Reading your product</p>
          <h1 className="truncate text-xl font-semibold">{String(run.input.url ?? "")}</h1>
        </div>
        {summary ? <SummaryView summary={summary} /> : <LiveFeed runId={run.id} initialStatus={run.status} />}
      </main>
    </>
  );
}

function SummaryView({ summary }: { summary: ProductSummary }) {
  return (
    <article className="flex flex-col gap-6 rounded-md border border-zinc-800 p-6">
      <div>
        <h2 className="text-2xl font-semibold">{summary.name}</h2>
        <p className="mt-1 text-zinc-300">{summary.oneLiner}</p>
      </div>
      <Section title="Who it's for">
        <p>{summary.whoItsFor}</p>
      </Section>
      <Section title="What it does">
        <ul className="list-disc space-y-1 pl-5">
          {summary.whatItDoes.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </Section>
      <Section title="Pricing">
        <p>{summary.pricing ?? "Not stated on the page."}</p>
      </Section>
      {summary.notes && (
        <Section title="Notes">
          <p className="text-zinc-400">{summary.notes}</p>
        </Section>
      )}
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-sm font-medium text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}
