import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatUsd } from "@mkt/core/cost";
import { KIND_LABELS, REWRITE_PRICE_MICROS, cardStatus, postEditorView } from "@mkt/core/engine";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { PostEditor, type EditorVariant } from "@/components/content/post-editor";
import { StatusChip, when } from "@/components/content/status";
import { ProjectTabs } from "@/components/project-tabs";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../../../header";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "$0.005": sub-cent prices without trailing zeros. */
const price = (m: number) => (m < 10_000 ? formatUsd(m).replace(/(\.\d*?[1-9])0+$/, "$1") : formatUsd(m));

export default async function PostEditorPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!UUID.test(id)) notFound();
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const view = await postEditorView(db, s.workspaceId, id);
  if (!view) notFound();

  const status = cardStatus(view.status, view.variants.flatMap((v) => v.posts.map((p) => p.state)));
  const board = `/p/${encodeURIComponent(product.slug)}/content`;
  const variants: EditorVariant[] = view.variants.map((v) => ({
    id: v.id,
    platform: v.platform,
    platformLabel: v.platformLabel,
    kind: v.kind,
    limit: v.limit,
    text: v.text,
    parts: v.parts,
    hashtags: v.hashtags,
    firstComment: v.firstComment,
    issues: v.issues.map((i) => ({ severity: i.severity, message: i.message, code: i.code })),
    posts: v.posts.map((p) => ({ id: p.id, state: p.state, when: when(p.scheduledAt, ws.timezone), connected: p.connected })),
    lockedReason: v.lockedReason,
    lastRewrite: v.lastRewrite,
  }));

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <ProjectTabs slug={product.slug} />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link href={board} className="text-sm text-zinc-500 hover:text-zinc-300">
              ← Campaign board
            </Link>
            <h1 className="text-2xl font-semibold">
              {KIND_LABELS[view.kind]}
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
          <section className="flex flex-col gap-2" aria-label="Facts this leans on">
            <h2 className="text-sm font-medium text-zinc-400">Facts this leans on</h2>
            <ul className="flex flex-wrap gap-2">
              {view.claims.map((c) => (
                <li
                  key={c.ref}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${c.publicOk && c.status !== "rejected" ? "border-zinc-700 text-zinc-300" : "border-red-900 text-red-300"}`}
                  title={c.publicOk ? "Has a public source" : "Can't be said in public"}
                >
                  {c.text}
                  {!c.publicOk && " (private)"}
                  {c.status === "rejected" && " (you marked it wrong)"}
                </li>
              ))}
            </ul>
          </section>
        )}

        {variants.length ? (
          <PostEditor slug={product.slug} variants={variants} rewritePrice={price(REWRITE_PRICE_MICROS)} />
        ) : (
          <p className="text-zinc-400">{status === "Drafting" ? "This one is still being written. It shows up here when it's ready." : "Nothing was written for this one."}</p>
        )}
      </main>
    </>
  );
}
