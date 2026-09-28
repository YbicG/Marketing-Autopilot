import { env } from "@mkt/core/config";
import { listPats } from "@mkt/core/tools";
import { shortDate } from "@/components/settings/vault";
import { SCOPE_LABELS, setupLine } from "@/components/settings/token-copy";
import { NewTokenForm, RevokeButton } from "@/components/settings/token-panel";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Settings → Agent access (§9): personal access tokens for Claude Code or another agent over MCP.
 * Tokens are listed by name and prefix only; the secret was shown once, when it was made.
 */
export default async function TokensPage() {
  const s = await requireWorkspace();
  const tokens = await listPats(getDb(), s.workspaceId);
  const base = env().APP_BASE_URL.replace(/\/$/, "");
  const now = Date.now();
  const live = tokens.filter((t) => !t.revokedAt && !(t.expiresAt && t.expiresAt.getTime() <= now));
  const old = tokens.filter((t) => !live.includes(t));

  return (
    <main className="flex max-w-5xl flex-col gap-8 px-4 md:px-10 py-8">
      <div>
        <h1 className="font-serif text-4xl tracking-tight">Agent access</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Let Claude Code or another agent work with your projects. It can look things up, write drafts and, if you allow it, start campaigns within a
          small budget. Nothing it writes goes out until you approve it here.
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-label="New token">
        <h2 className="text-lg font-semibold">New token</h2>
        <NewTokenForm baseUrl={base} />
        <p className="text-sm text-zinc-400">Then connect it from a terminal:</p>
        <code className="break-all rounded bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300">{setupLine(base, "<token>")}</code>
      </section>

      <section className="flex flex-col gap-3" aria-label="Your tokens">
        <h2 className="text-lg font-semibold">Your tokens</h2>
        {live.length === 0 ? (
          <p className="text-sm text-zinc-500">No tokens yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {live.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-800 p-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{t.name}</span>
                  <span className="font-mono text-xs text-zinc-500">{t.display}</span>
                  <span className="text-xs text-zinc-400">
                    {t.scopes.map((x) => SCOPE_LABELS[x].label).join(" · ")} · made {shortDate(t.createdAt)} ·{" "}
                    {t.lastUsedAt ? `last used ${shortDate(t.lastUsedAt)}` : "never used"}
                    {t.expiresAt ? ` · stops ${shortDate(t.expiresAt)}` : ""}
                  </span>
                </div>
                <RevokeButton id={t.id} name={t.name} />
              </li>
            ))}
          </ul>
        )}
        {old.length > 0 && (
          <details className="text-sm text-zinc-400">
            <summary className="cursor-pointer">Revoked or expired ({old.length})</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {old.map((t) => (
                <li key={t.id}>
                  {t.name} <span className="font-mono text-xs text-zinc-500">{t.display}</span> ·{" "}
                  {t.revokedAt ? `revoked ${shortDate(t.revokedAt)}` : `expired ${shortDate(t.expiresAt!)}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </main>
  );
}
