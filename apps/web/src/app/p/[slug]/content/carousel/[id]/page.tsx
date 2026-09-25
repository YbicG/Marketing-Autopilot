import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CAROUSEL_TEMPLATES, type CarouselTemplate } from "@mkt/contracts";
import { formatUsd } from "@mkt/core/cost";
import { carouselEditorView, cardStatus, slideContrast } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { CarouselEditor, type CarouselVariantView } from "@/components/content/carousel-editor";
import { StatusChip, when } from "@/components/content/status";
import { ProjectTabs } from "@/components/project-tabs";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../../../header";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CarouselEditorPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!UUID.test(id)) notFound();
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const view = await carouselEditorView(db, s.workspaceId, id);
  if (!view) notFound();

  const status = cardStatus(view.status, view.variants.flatMap((v) => v.posts.map((p) => p.state)));
  const contrastByTemplate = Object.fromEntries(
    CAROUSEL_TEMPLATES.map((t) => [t, slideContrast(t, view.colors, true).map((c) => c.message)]),
  ) as Record<CarouselTemplate, string[]>;
  const variants: CarouselVariantView[] = view.variants.map((v) => ({
    id: v.id,
    platform: v.platform,
    label: v.output.label,
    output: v.output.description,
    caption: v.caption,
    captionLimit: v.captionLimit,
    renderedAssetIds: v.renderedAssetIds,
    pdf: v.platform === "linkedin",
    rendering: v.rendering,
    issues: v.issues.map((i) => ({ severity: i.severity, message: i.message })),
    posts: v.posts.map((p) => ({ id: p.id, state: p.state, when: when(p.scheduledAt, ws.timezone) })),
    lockedReason: v.lockedReason,
  }));

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={product.slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link href={`/p/${encodeURIComponent(product.slug)}/content`} className="text-sm text-zinc-500 hover:text-zinc-300">
              ← Campaign board
            </Link>
            <h1 className="text-2xl font-semibold">
              Swipe post
              {view.day !== null && <span className="text-zinc-500"> · day {view.day}</span>}
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <StatusChip status={status} />
            <span>Cost {formatUsd(view.costMicros)}</span>
          </div>
        </div>
        {view.needsYouReason && status === "Needs you" && (
          <p className="rounded-md border border-amber-800 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">{view.needsYouReason}</p>
        )}
        {view.claims.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Facts this leans on">
            {view.claims.map((c) => (
              <li key={c.ref} className={`rounded-full border px-2.5 py-0.5 text-xs ${c.publicOk ? "border-zinc-700 text-zinc-300" : "border-red-900 text-red-300"}`}>
                {c.text}
                {!c.publicOk && " (private)"}
              </li>
            ))}
          </ul>
        )}
        {view.slides.length ? (
          <CarouselEditor
            slug={product.slug}
            initialSlides={view.slides}
            variants={variants}
            screenshots={view.screenshots}
            contrastByTemplate={contrastByTemplate}
          />
        ) : (
          <p className="text-zinc-400">{status === "Drafting" ? "This one is still being written. It shows up here when it's ready." : "Nothing usable came back for this one. Make another from the board."}</p>
        )}
      </main>
    </>
  );
}
