import { notFound, redirect } from "next/navigation";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { projectAssets, type LibraryAsset } from "@mkt/core/video";
import { ProjectTabs } from "@/components/project-tabs";
import { MediaUploader } from "@/components/video/media-uploader";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../header";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  screenshot: "Screenshot",
  image: "Image",
  recording: "Screen recording",
  video: "Finished video",
  audio: "Audio",
  still: "Still",
  pdf: "PDF",
};

const ORIGIN_LABEL: Record<string, string> = {
  captured: "Recorded from your site or demo",
  uploaded: "Uploaded by you",
  generated: "Made with AI",
  licensed: "Licensed",
  template: "Template",
};

const TIER: Record<string, { label: string; note: string; tone: string }> = {
  A: { label: "Real screens", note: "Captured, uploaded or a template. No AI label needed.", tone: "border-emerald-800 text-emerald-300" },
  B: { label: "AI voice or sound", note: "Includes an AI voice, music or a checked non-photo AI image. Posts using it get the platform's AI label.", tone: "border-amber-800 text-amber-300" },
  C: { label: "AI images", note: "Includes AI-made images or video. Posts using it get the platform's AI label.", tone: "border-fuchsia-900 text-fuchsia-300" },
};

const secs = (ms: number | null) => (ms ? `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}` : "");
const size = (b: number | null) => (b === null ? "" : b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);
const isVisual = (a: LibraryAsset) => a.mime.startsWith("image/");
const isPlayable = (a: LibraryAsset) => a.mime.startsWith("video/");

export default async function AssetsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const { assets, counts } = await projectAssets(db, s.workspaceId, product.id);

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Assets</h1>
          <p className="text-sm text-zinc-400">
            Screenshots, screen recordings and finished videos for {product.name}. Each shows where it came from, which decides whether a post needs an AI label.
          </p>
        </div>

        <MediaUploader slug={slug} />

        <div className="flex flex-wrap gap-3 text-xs text-zinc-400">
          <span>{counts.total} total</span>
          {(["A", "B", "C"] as const).map((t) => (
            <span key={t} className={`rounded border px-1.5 py-0.5 ${TIER[t]!.tone}`} title={TIER[t]!.note}>
              {TIER[t]!.label}: {counts.byTier[t]}
            </span>
          ))}
          {counts.personalData > 0 && <span className="text-amber-300">{counts.personalData} show personal details and are kept out of videos</span>}
        </div>

        {assets.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing here yet. Upload a screenshot or recording above, or record your demo on the Capture page.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((a) => {
              const tier = TIER[a.tier] ?? TIER.A!;
              return (
                <li key={a.id} className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3">
                  {isVisual(a) ? (
                    <img src={`/api/media/${a.id}?v=preview`} alt={KIND_LABEL[a.kind] ?? "Asset"} className="h-40 w-full rounded bg-zinc-900 object-contain" loading="lazy" />
                  ) : isPlayable(a) ? (
                    <video src={`/api/media/${a.id}`} controls preload="none" className="h-40 w-full rounded bg-black" />
                  ) : (
                    <div className="flex h-40 items-center justify-center rounded bg-zinc-900 text-xs text-zinc-500">{KIND_LABEL[a.kind] ?? a.kind}</div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>{KIND_LABEL[a.kind] ?? a.kind}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-xs ${tier.tone}`} title={tier.note}>
                      {tier.label}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400">{ORIGIN_LABEL[a.origin] ?? a.origin}</p>
                  {a.from && <p className="truncate text-xs text-zinc-500" title={a.from}>{a.from}</p>}
                  <p className="text-xs text-zinc-500">
                    {[a.width && a.height ? `${a.width}×${a.height}` : "", secs(a.durationMs), size(a.sizeBytes), new Date(a.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {a.hasPersonalData && <p className="text-xs text-amber-300">Shows personal details, so it won't be used in videos.</p>}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
