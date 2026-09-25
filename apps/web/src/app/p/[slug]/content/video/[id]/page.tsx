import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { VideoSpec } from "@mkt/contracts";
import { formatUsd, loadRateCards, rateLookup } from "@mkt/core/cost";
import { cardStatus } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import {
  estimateChangeRequestMicros,
  estimateHooksMoreMicros,
  estimateRevoiceMicros,
  isUsableClaim,
  loadVideoContext,
  videoEditorView,
  VideoItemMissing,
} from "@mkt/core/video";
import { createElevenLabsAudio } from "@mkt/providers";
import { StatusChip, when } from "@/components/content/status";
import { ProjectTabs } from "@/components/project-tabs";
import { VideoEditor, type VideoEditorProps } from "@/components/video/video-editor";
import { finalizeEstimate, hasVoiceKey } from "@/app/api/videos/_lib/deps";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../../../header";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "$0.005": sub-cent prices without trailing zeros. */
const price = (m: number) => (m < 10_000 ? formatUsd(m).replace(/(\.\d*?[1-9])0+$/, "$1") : formatUsd(m));

const ITEM_STATUS_NOTE: Partial<Record<string, string>> = {
  planned: "This video hasn't been started yet. It's written with the rest of the campaign.",
  generating: "This video is being written and voiced. The preview shows up here when it's ready.",
  finalizing: "Making the 3 final versions. This takes a few minutes; the page updates itself.",
  skipped: "This video was skipped.",
};

export default async function VideoEditorPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!UUID.test(id)) notFound();
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();

  let view: Awaited<ReturnType<typeof videoEditorView>>;
  let ctx: Awaited<ReturnType<typeof loadVideoContext>>;
  try {
    [view, ctx] = await Promise.all([videoEditorView(db, s.workspaceId, id), loadVideoContext(db, s.workspaceId, id)]);
  } catch (err) {
    if (err instanceof VideoItemMissing) notFound();
    throw err;
  }
  if (view.item.productId !== product.id || view.item.kind !== "video") notFound();

  const rates = rateLookup(await loadRateCards(db));
  const voice = await hasVoiceKey(s.workspaceId);
  // Estimates only: no call is made. Without a key there is no voice to pay for.
  const audio = voice ? createElevenLabsAudio() : null;
  const spec = view.spec as VideoSpec | null;
  const now = new Date();
  const usable = ctx.claims.filter((c) => isUsableClaim(c, now));

  const status = cardStatus(view.item.status, view.posts.map((p) => p.state));
  const board = `/p/${encodeURIComponent(product.slug)}/content`;

  const props: VideoEditorProps | null = spec
    ? {
        slug: product.slug,
        itemId: view.item.id,
        status: view.item.status,
        needsYouReason: view.item.needsYouReason,
        spec,
        specId: view.specId!,
        version: view.version,
        editedBy: view.editedBy,
        savedIssues: view.issues.map((i) => ({ severity: i.severity, message: i.message, code: i.code, ...(i.sceneId ? { sceneId: i.sceneId } : {}) })),
        lines: view.lines,
        musicAssetId: view.musicAssetId,
        noVoice: view.noVoice || !voice,
        hasVoiceKey: voice,
        moreHooks: view.moreHooks,
        checks: view.checks,
        hookOrder: view.hookOrder,
        hookOrderSource: view.hookOrderSource,
        finalizeHash: view.finalizeHash,
        finalizeConfirmed: view.finalizeConfirmed,
        final: view.final,
        renders: view.renders,
        files: view.files,
        posts: view.posts.map((p) => ({ ...p, when: when(p.scheduledAt, ws.timezone) })),
        footage: view.footage,
        publicClaimRefs: usable.map((c) => c.ref),
        verifiedClaimRefs: usable.filter((c) => c.status === "verified").map((c) => c.ref),
        prices: {
          hooksMore: price(estimateHooksMoreMicros(rates)),
          changeRequest: price(estimateChangeRequestMicros(rates, JSON.stringify(spec).length)),
          finalize: price(finalizeEstimate(audio, spec, view.lines)),
          // Per spoken word on the draft voice, for the Save button's price (the page adds up changed lines).
          revoicePerWordMicros: audio ? estimateRevoiceMicros(audio, ["word ".repeat(100).trim()], spec.voice.voiceId) / 100 : 0,
        },
      }
    : null;

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={product.slug} />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link href={board} className="text-sm text-zinc-500 hover:text-zinc-300">
              ← Campaign board
            </Link>
            <h1 className="text-2xl font-semibold">
              Video
              {ctx.item.day !== null && <span className="text-zinc-500"> · day {ctx.item.day}</span>}
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <StatusChip status={status} />
            {view.version !== null && <span>Version {view.version}</span>}
            <span>Cost so far {formatUsd(ctx.item.costMicros)}</span>
          </div>
        </div>

        {props ? (
          <VideoEditor key={props.specId} {...props} />
        ) : (
          <p className="text-zinc-400">{ITEM_STATUS_NOTE[view.item.status] ?? view.item.needsYouReason ?? "Nothing was made for this one yet."}</p>
        )}
      </main>
    </>
  );
}
