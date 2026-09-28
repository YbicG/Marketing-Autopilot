import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { KIT_KINDS, KIT_LABELS } from "@mkt/contracts";
import { formatUsd } from "@mkt/core/cost";
import { productBySlug } from "@mkt/core/ingest";
import { estimateKitRun, kitPlanForProduct, kitView, lastKitInputs } from "@mkt/core/launch";
import { getWorkspace } from "@mkt/core/tenancy";
import { KitLive } from "@/components/launch/kit-live";
import { draftFromInputs, kindSlug, kitSummary, launchDayLabel, writeAllKinds } from "@/components/launch/kit-model";
import { KitOverview, type KitOverviewCard } from "@/components/launch/kit-write";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The launch kit (§5.4 LC launch kit, §8 endorsements): one card per part, written on your server. */
export default async function LaunchKitsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const plan = await kitPlanForProduct(db, s.workspaceId, product.id);
  const view = plan ? await kitView(db, s.workspaceId, plan.id) : null;

  const shell = (children: ReactNode) => (
    <>
      <main className="flex max-w-5xl flex-col gap-6 px-4 py-8 md:px-10">
        <div>
          <Link href={`/p/${product.slug}/launch`} className="inline-flex min-h-11 items-center text-sm text-zinc-500 hover:text-zinc-300 md:min-h-8">
            ← Launch
          </Link>
          <h1 className="font-serif text-4xl tracking-tight">Launch kit</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Everything you send or post yourself around launch day. Nothing here is sent or posted for you.
          </p>
        </div>
        {children}
      </main>
    </>
  );

  if (!plan || !view) {
    return shell(
      <p className="text-zinc-400">
        There&apos;s no launch plan yet.{" "}
        <Link href={`/p/${product.slug}/launch`} className="underline underline-offset-2">
          Set up your launch
        </Link>{" "}
        first; the kit is written for your launch day.
      </p>,
    );
  }

  const byKind = new Map(view.kits.map((k) => [k.kind, k]));
  const cards: KitOverviewCard[] = KIT_KINDS.map((kind) => {
    const k = byKind.get(kind);
    return {
      kind,
      label: k?.label ?? KIT_LABELS[kind],
      status: k?.status ?? "missing",
      href: `/p/${product.slug}/launch/kits/${kindSlug(kind)}`,
      priceLabel: formatUsd(estimateKitRun([kind]).expected),
      blocks: k?.issues.filter((i) => i.severity === "block").length ?? 0,
      warns: k?.issues.filter((i) => i.severity === "warn").length ?? 0,
      needsYouReason: k?.needsYouReason ?? null,
      exportBlockedReason: k?.exportBlockedReason ?? null,
      summary: k ? kitSummary(kind, k.body) : null,
    };
  });
  const pending = writeAllKinds(cards);
  const liveRunIds = [...new Set(view.kits.filter((k) => (k.status === "generating" || k.status === "planned") && k.runId).map((k) => k.runId!))];
  const inputs = await lastKitInputs(db, s.workspaceId, plan.id);

  return shell(
    <>
      <p className="text-sm text-zinc-400">Launch day: {launchDayLabel(view.launchDate)}.</p>
      {liveRunIds.length > 0 && <KitLive runIds={liveRunIds} />}
      <KitOverview
        launchPlanId={plan.id}
        cards={cards}
        initialDraft={draftFromInputs(inputs)}
        allPriceLabel={pending.length ? formatUsd(estimateKitRun(pending).expected) : null}
      />
    </>,
  );
}
