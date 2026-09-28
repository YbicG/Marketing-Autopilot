import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { configuredPurposes, formatUsd } from "@mkt/core/cost";
import { BROADCAST_PRICE_MICROS, emailSettingsView, listBroadcasts } from "@mkt/core/email";
import { productBySlug } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { RESEND_API_KEY } from "@mkt/providers";
import { NewBroadcast } from "@/components/email/new-broadcast";
import { sendTime, tzName } from "@/components/email/labels";
import { SenderSettings } from "@/components/email/sender-settings";
import { StatusPill } from "@/components/email/status-pill";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Email tab (§2.5 default, §5.4 Email "LC"): one approved seasonal email to past buyers, through Resend. */
export default async function EmailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const [broadcasts, settings, configured] = await Promise.all([
    listBroadcasts(db, s.workspaceId, product.id),
    emailSettingsView(db, s.workspaceId, product.id),
    configuredPurposes(db, s.workspaceId),
  ]);
  // Resend isn't on the capability list yet, so its env fallback is checked here (presence only).
  const hasResendKey = configured.has(RESEND_API_KEY) || !!process.env.RESEND_API_KEY;
  const tz = ws.timezone;
  const open = broadcasts.find((b) => b.status !== "sent" && b.status !== "canceled");

  return (
    <>
      <main className="flex max-w-5xl flex-col gap-8 px-4 py-8 md:px-10">
        <div>
          <h1 className="font-serif text-4xl tracking-tight">Email</h1>
          <p className="mt-1 text-sm text-zinc-400">
            One seasonal email to people who already bought {product.name}, sent through your Resend account. Nothing goes out until you approve it.
          </p>
        </div>

        {!hasResendKey && (
          <p className="rounded-md border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
            Add your Resend API key in{" "}
            <Link href="/settings/keys" className="underline underline-offset-2">
              Settings → Keys
            </Link>{" "}
            before you can pick a list or send. You can still write the email now.
          </p>
        )}

        <section className="flex flex-col gap-3" aria-labelledby="emails">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="emails" className="text-lg font-semibold">
              Emails
            </h2>
            {open ? (
              <Link href={`/p/${encodeURIComponent(slug)}/email/${open.id}`} className="inline-flex min-h-11 items-center text-sm text-zinc-300 underline underline-offset-2 md:min-h-9">
                Open the email in progress
              </Link>
            ) : (
              <NewBroadcast slug={slug} priceLabel={formatUsd(BROADCAST_PRICE_MICROS)} disabled={!ws.onboardedAt} />
            )}
          </div>
          {!ws.onboardedAt && <p className="text-sm text-zinc-500">Set your monthly spending limit in Settings first.</p>}
          {broadcasts.length === 0 ? (
            <p className="text-sm text-zinc-500">No emails yet. Claude writes a short one in your voice; you check it, pick the send time and approve.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-800 rounded-md border border-zinc-800">
              {broadcasts.map((b) => {
                const when = b.status === "sent" ? sendTime(b.sentAt, tz) : sendTime(b.scheduledAt, tz);
                return (
                  <li key={b.id}>
                    <Link href={`/p/${encodeURIComponent(slug)}/email/${b.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-zinc-900/60">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill status={b.status} />
                        <span className="min-w-0 break-words font-medium">{b.subject || b.name}</span>
                      </div>
                      <p className="text-xs text-zinc-400">
                        {when ? `${b.status === "sent" ? "Sent" : "Sends"} ${when} (${tzName(tz)} time)` : "No send time yet"}
                        {b.audienceLabel ? ` · to ${b.audienceLabel}` : ""}
                        {b.blocking > 0 ? ` · ${b.blocking} to fix` : ""}
                        {b.warnings > 0 ? ` · ${b.warnings} to check` : ""}
                      </p>
                      {b.lastError && (b.status === "failed" || b.status === "pending_approval" || b.status === "draft") && (
                        <p className={`text-xs ${b.status === "failed" ? "text-red-300" : "text-amber-300"}`}>{b.lastError}</p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <SenderSettings slug={slug} initial={settings?.settings ?? null} missing={settings?.missing ?? []} hasResendKey={hasResendKey} />
      </main>
    </>
  );
}
