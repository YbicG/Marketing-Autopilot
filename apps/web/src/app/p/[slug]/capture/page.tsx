import { notFound, redirect } from "next/navigation";
import { captureView, estimateFlowPlanMicros, SYLLACAL_ROUTE_DENYLIST_SUGGESTION } from "@mkt/core/capture";
import { formatUsd, loadRateCards, rateLookup } from "@mkt/core/cost";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { FlowList, type FlowRow } from "@/components/capture/flows";
import { LoginForm, OriginForm } from "@/components/capture/setup-forms";
import { ProjectTabs } from "@/components/project-tabs";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../header";

export const dynamic = "force-dynamic";

/** "$0.02": sub-cent prices without trailing zeros. */
const price = (m: number) => (m < 10_000 ? formatUsd(m).replace(/(\.\d*?[1-9])0+$/, "$1") : formatUsd(m));

export default async function CapturePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const [view, rates] = await Promise.all([captureView(db, s.workspaceId, product.id), loadRateCards(db).then(rateLookup)]);
  if (!view) notFound();

  const flows: FlowRow[] = view.flows.map((f) => ({
    id: f.id,
    name: f.name,
    steps: f.steps,
    needsLogin: f.needsLogin,
    needsConfirm: f.needsConfirm,
    confirmedAt: f.confirmedAt,
    lastError: f.lastError,
    recording: f.recording,
  }));

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Record your demo</h1>
          <p className="text-sm text-zinc-400">
            Record short screen videos of {product.name} to use in videos. The recorder follows steps you check, on a demo copy of your app, and every recording is checked for
            personal details before it can be used.
          </p>
        </div>
        <OriginForm slug={slug} origin={view.origin} denylist={view.denylist} suggestion={[...SYLLACAL_ROUTE_DENYLIST_SUGGESTION]} />
        <LoginForm slug={slug} hasLogin={view.hasLogin} />
        <FlowList slug={slug} flows={flows} origin={view.origin} hasLogin={view.hasLogin} suggestPrice={price(estimateFlowPlanMicros(rates))} />
      </main>
    </>
  );
}
