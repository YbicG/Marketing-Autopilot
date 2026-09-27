import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdsExportBody, KIT_BODY_SCHEMAS, KIT_LABELS, type LaunchKitBody } from "@mkt/contracts";
import { formatUsd } from "@mkt/core/cost";
import { productBySlug } from "@mkt/core/ingest";
import { estimateKitRun, kitFileCtxFor, kitPlanForProduct, kitView, lastKitInputs, resolveKitLinks } from "@mkt/core/launch";
import { assistedCards } from "@mkt/core/publishing";
import { getWorkspace } from "@mkt/core/tenancy";
import { AdsKitView, AdsLimits, AdsSpendBanner } from "@/components/launch/kit-ads";
import { KitDownload } from "@/components/launch/kit-download";
import { KitEditor } from "@/components/launch/kit-editor";
import { KitLive } from "@/components/launch/kit-live";
import { draftFromInputs, KIND_BLURB, kindFromSlug, launchDayLabel } from "@/components/launch/kit-model";
import { KitCostChip, KitDisclosureStatus, KitIssues, KitStatusChip } from "@/components/launch/kit-status";
import { SubredditTasks } from "@/components/launch/kit-subreddit";
import { KitWriteAgain } from "@/components/launch/kit-write";
import { ReplyBank } from "@/components/launch/reply-bank";
import { ProjectTabs } from "@/components/project-tabs";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../../../header";

export const dynamic = "force-dynamic";

/** One part of the launch kit: read it, edit it, check it, download it (§5.4, §8). */
export default async function LaunchKitPage({ params }: { params: Promise<{ slug: string; kind: string }> }) {
  const { slug, kind: kindParam } = await params;
  const kind = kindFromSlug(kindParam);
  if (!kind) notFound();
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const plan = await kitPlanForProduct(db, s.workspaceId, product.id);
  const view = plan ? await kitView(db, s.workspaceId, plan.id) : null;
  const label = KIT_LABELS[kind];
  const priceLabel = formatUsd(estimateKitRun([kind]).expected);

  const shell = (chips: ReactNode, children: ReactNode) => (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={product.slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <div>
          <Link href={`/p/${product.slug}/launch/kits`} className="text-sm text-zinc-500 hover:text-zinc-300">
            ← Launch kit
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{label}</h1>
            {chips}
          </div>
          <p className="mt-1 text-sm text-zinc-400">{KIND_BLURB[kind]}</p>
        </div>
        {children}
      </main>
    </>
  );

  if (!plan || !view) {
    return shell(
      null,
      <p className="text-zinc-400">
        There&apos;s no launch plan yet.{" "}
        <Link href={`/p/${product.slug}/launch`} className="underline underline-offset-2">
          Set up your launch
        </Link>{" "}
        first.
      </p>,
    );
  }

  const inputs = await lastKitInputs(db, s.workspaceId, plan.id);
  const draft = draftFromInputs(inputs);
  const kit = view.kits.find((k) => k.kind === kind);
  if (!kit) {
    return shell(
      <KitStatusChip status="missing" />,
      <>
        {kind === "ads_export" && <AdsSpendBanner />}
        <KitWriteAgain launchPlanId={plan.id} kind={kind} priceLabel={priceLabel} initialDraft={draft} disabled={false} firstTime />
        {kind === "ads_export" && <AdsLimits />}
      </>,
    );
  }

  const writing = kit.status === "generating" || kit.status === "planned";
  const fileCtx = kitFileCtxFor(product, view.launchDate);

  let content: ReactNode;
  if (kind === "ads_export") {
    const parsed = kit.body ? AdsExportBody.safeParse(kit.body) : null;
    content = parsed?.success ? (
      <AdsKitView body={parsed.data} />
    ) : (
      <>
        {!writing && <p className="text-sm text-zinc-400">There are no ad ideas to show yet.</p>}
        <AdsLimits />
      </>
    );
  } else if (!kit.body) {
    content = <p className="text-sm text-zinc-400">{writing ? "It's being written. This page fills in when it's done." : "Nothing was written. Write it again."}</p>;
  } else {
    const parsed = KIT_BODY_SCHEMAS[kind].safeParse(kit.body);
    if (!parsed.success) {
      content = <p className="text-sm text-amber-300">This kit was saved in an older shape we can&apos;t edit here. Write it again to get a fresh one.</p>;
    } else {
      const body = parsed.data as LaunchKitBody;
      const editor = <KitEditor kitId={kit.id} body={body} updatedAt={kit.updatedAt} locked={writing} />;
      if (body.kind === "reply_bank") {
        const replies = body.replies.map((r) => ({ trigger: r.trigger, reply: resolveKitLinks(r.reply, fileCtx, "reply_bank") }));
        content = (
          <>
            <ReplyBank replies={replies} />
            <details className="rounded-lg border border-zinc-800 p-4">
              <summary className="cursor-pointer text-sm text-zinc-300">Edit the replies</summary>
              <div className="mt-4">{editor}</div>
            </details>
          </>
        );
      } else if (body.kind === "subreddit") {
        const ids = new Set(kit.assistedTasks.map((t) => t.id));
        const open = (await assistedCards(db, s.workspaceId, { productId: product.id })).filter((t) => ids.has(t.id));
        content = (
          <>
            <SubredditTasks open={open} all={kit.assistedTasks} />
            <div className="flex flex-col gap-2">
              <h2 className="text-lg font-semibold">Edit the drafts</h2>
              <p className="text-sm text-zinc-400">Saving updates the Copy &amp; open tasks above. Tasks you already posted stay as they are.</p>
              {editor}
            </div>
          </>
        );
      } else {
        content = editor;
      }
    }
  }

  return shell(
    <>
      <KitStatusChip status={kit.status} />
      <KitCostChip label={priceLabel} />
    </>,
    <>
      {kind === "ads_export" && <AdsSpendBanner />}
      {writing && kit.runId && <KitLive runIds={[kit.runId]} />}
      {kit.needsYouReason && <p className="rounded-md border border-amber-800 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">{kit.needsYouReason}</p>}

      <section className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="font-medium">Checks</h2>
          {writing ? <p className="text-sm text-zinc-400">Checks run when it&apos;s written.</p> : <KitIssues issues={kit.issues} />}
          {!writing && <KitDisclosureStatus ok={kit.disclosuresOk} kind={kind} />}
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <KitDownload kitId={kit.id} blockedReason={kit.exportBlockedReason} label={kind === "ads_export" ? "Download ad kit" : "Download kit"} />
          <p className="text-xs text-zinc-500">For launch day, {launchDayLabel(view.launchDate)}.</p>
          <KitWriteAgain launchPlanId={plan.id} kind={kind} priceLabel={priceLabel} initialDraft={draft} disabled={writing} firstTime={false} />
        </div>
      </section>

      {content}
    </>,
  );
}
