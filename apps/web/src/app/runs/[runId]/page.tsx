import { notFound, redirect } from "next/navigation";
import { INGEST_STAGES, ProductSummary, STRATEGY_STAGES } from "@mkt/contracts";
import { questionsForRun } from "@mkt/core/ingest";
import { getRun } from "@mkt/core/runs";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../header";
import { IngestFeed } from "./ingest-feed";
import { LiveFeed } from "./live-feed";
import type { QuestionState } from "./gap-question";

export const dynamic = "force-dynamic";

const STAGES_BY_KIND: Record<string, readonly { id: string; label: string }[]> = {
  ingest: INGEST_STAGES,
  dna_regenerate: [{ id: "profile", label: "Writing your profile" }],
  strategy: STRATEGY_STAGES,
};

const TITLE_BY_KIND: Record<string, string> = {
  ingest: "Reading your product",
  dna_regenerate: "Rewriting your profile",
  strategy: "Picking your angles",
};

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const [ws, run] = await Promise.all([getWorkspace(db, s.workspaceId), getRun(db, s.workspaceId, runId)]);
  if (!ws) redirect("/signin");
  if (!run) notFound();

  if (run.kind === "m0_summary") {
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

  const product = run.productId
    ? await db.query.products.findFirst({
        where: (p, { and, eq }) => and(eq(p.id, run.productId!), eq(p.workspaceId, s.workspaceId)),
      })
    : undefined;
  const slug = typeof run.input.slug === "string" ? run.input.slug : (product?.slug ?? null);
  const planHref = slug ? `/p/${encodeURIComponent(slug)}/plan` : null;
  if (run.status === "completed" && planHref) redirect(planHref);

  const questions: QuestionState[] = (await questionsForRun(db, s.workspaceId, [run.id])).map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options,
    status: q.answeredAt ? (q.skipped ? "skipped" : "answered") : "open",
    answer: q.answer,
  }));
  const links = Array.isArray(run.input.links) ? run.input.links.filter((l): l is string => typeof l === "string") : [];

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10">
        <div>
          <p className="text-sm text-zinc-500">{TITLE_BY_KIND[run.kind] ?? "Working"}</p>
          <h1 className="truncate text-xl font-semibold">{product?.name ?? (links.join(", ") || "Your product")}</h1>
        </div>
        <IngestFeed
          runId={run.id}
          kind={run.kind}
          stages={STAGES_BY_KIND[run.kind] ?? []}
          initialStatus={run.status}
          initialQuestions={questions}
          planHref={planHref}
        />
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
