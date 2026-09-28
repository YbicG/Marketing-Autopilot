import Link from "next/link";
import { redirect } from "next/navigation";
import { formatUsd } from "@mkt/core/cost";
import { getWorkspace } from "@mkt/core/tenancy";
import { loadToolConfirm } from "@mkt/core/tools";
import { ConfirmSpend } from "@/components/agent/confirm-spend";
import { AppShell } from "@/components/shell/app-shell";
import { toolDeps } from "@/lib/agent-tools";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

/** What each spend tool does, in words (the tool's own description is written for the agent). */
const WHAT: Record<string, string> = {
  run_package: "Start a 30-day campaign package: it writes the posts, swipe posts and videos as drafts for you to approve.",
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

function describe(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * The page a pending_confirmation link opens (D10, §9): an agent asked to spend more than its
 * token may on its own. Shows what, for which token and the price worked out now; Confirm gives
 * a one-time code for the agent.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const sp = await searchParams;
  const q = { tool: one(sp.tool), pat: one(sp.pat), input: one(sp.input) };
  const r = await loadToolConfirm(db, s.workspaceId, q, toolDeps());

  return (
    <AppShell workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} userName={s.name}>
      <main className="flex max-w-3xl flex-col gap-6 px-4 py-10 md:px-10">
        <header>
          <h1 className="font-serif text-4xl tracking-tight">Your agent wants to spend</h1>
          <p className="mt-1 text-muted">Agents can spend up to $0.50 at a time and $10 a month on their own. This one needs your OK.</p>
        </header>
        {!r.ok ? (
          <p className="rounded-md border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">{r.message}</p>
        ) : (
          <section className="flex flex-col gap-4 rounded-md border border-zinc-800 p-5" aria-label="Request">
            <p>{WHAT[r.tool.name] ?? r.tool.description}</p>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-zinc-400">Token</dt>
              <dd>{r.patName}</dd>
              {Object.entries(r.input as Record<string, unknown>)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-zinc-400">{k}</dt>
                    <dd className="break-words">{describe(v)}</dd>
                  </div>
                ))}
              <dt className="text-zinc-400">Could cost up to</dt>
              <dd className="font-medium">{formatUsd(r.estimateMicros)}</dd>
            </dl>
            <p className="text-xs text-zinc-500">It still counts against your monthly limit. Whatever it makes waits for your approval.</p>
            <ConfirmSpend tool={r.tool.name} pat={r.patId} input={q.input ?? ""} price={formatUsd(r.estimateMicros)} />
          </section>
        )}
        <Link href="/settings/tokens" className="text-sm text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
          Manage agent access
        </Link>
      </main>
    </AppShell>
  );
}
