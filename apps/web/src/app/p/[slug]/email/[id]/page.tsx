import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { broadcastView, emailSettingsView } from "@mkt/core/email";
import { productBySlug } from "@mkt/core/ingest";
import { localDay, localTime } from "@mkt/core/publishing";
import { getRun } from "@mkt/core/runs";
import { getWorkspace } from "@mkt/core/tenancy";
import { BroadcastEditor } from "@/components/email/broadcast-editor";
import { StatusPill } from "@/components/email/status-pill";
import { WritingProgress } from "@/components/email/writing-progress";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function BroadcastPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const view = await broadcastView(db, s.workspaceId, id);
  if (!view || view.productId !== product.id) notFound();
  const settings = await emailSettingsView(db, s.workspaceId, product.id);
  const run = view.status === "draft" && view.runId ? await getRun(db, s.workspaceId, view.runId) : null;
  const writing = !!run && (run.status === "queued" || run.status === "running");
  const tz = ws.timezone;
  const at = view.scheduledAt ? new Date(view.scheduledAt) : null;
  const sa = settings?.settings;

  return (
    <>
      <main className="flex max-w-6xl flex-col gap-6 px-4 py-8 md:px-10">
        <div className="flex flex-col gap-2">
          <Link href={`/p/${encodeURIComponent(slug)}/email`} className="inline-flex min-h-11 items-center self-start text-sm text-zinc-400 hover:text-zinc-200 md:min-h-8">
            ← All emails
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words font-serif text-4xl tracking-tight">{view.name}</h1>
            <StatusPill status={view.status} />
          </div>
        </div>

        {writing ? (
          <WritingProgress runId={run.id} status={run.status} />
        ) : (
          <BroadcastEditor
            key={`${view.updatedAt}-${view.status}`}
            slug={slug}
            tz={tz}
            view={view}
            initialDay={at ? localDay(at, tz) : ""}
            initialTime={at ? localTime(at, tz) : ""}
            settingsAudience={sa?.audienceId ? { id: sa.audienceId, label: sa.audienceLabel ?? null } : null}
            missing={settings?.missing ?? []}
          />
        )}
      </main>
    </>
  );
}
