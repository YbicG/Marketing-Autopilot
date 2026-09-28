"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { LandingAuditView } from "@mkt/contracts";
import { postJson } from "@/lib/post-json";

const BTN = "min-h-11 md:min-h-9 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60";
const POLL_MS = 4_000;

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/**
 * Landing check (§5.4): Run it, wait while the server opens the page on a phone and a computer,
 * then each check with pass/fail and a plain detail, plus both screenshots. The three landing
 * gates follow its result; nothing here ticks them. Render with key={audit id + status} so a
 * server refresh replaces the local copy.
 */
export function LandingAudit({ slug, initial, price, website }: { slug: string; initial: LandingAuditView | null; price: string; website: string | null }) {
  const router = useRouter();
  const [audit, setAudit] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = audit?.status === "queued" || audit?.status === "running";

  useEffect(() => {
    if (!running) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/launch/audit/${encodeURIComponent(slug)}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const { audit: next } = (await res.json()) as { audit: LandingAuditView | null };
        if (stop || !next) return;
        setAudit(next);
        if (next.status === "done" || next.status === "failed") router.refresh();
      } catch {
        // A missed poll is fine; the next one tries again.
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [running, slug, router]);

  async function run() {
    if (busy || running) return;
    setBusy(true);
    setError(null);
    const out = await postJson<{ auditId: string; url: string }>(`/api/launch/audit/${encodeURIComponent(slug)}`, {});
    setBusy(false);
    if (!out.ok) return setError(out.error);
    const now = new Date().toISOString();
    setAudit({ id: out.data.auditId, url: out.data.url, status: "queued", passed: null, checks: [], screenshotAssetIds: [], error: null, createdAt: now, finishedAt: null });
  }

  const shots = audit?.screenshotAssetIds ?? [];
  const shotLabels = shots.length === 2 ? ["On a computer", "On a phone"] : shots.map(() => "Screenshot");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void run()} disabled={busy || running || !website} className={BTN}>
          {running ? "Checking your page…" : busy ? "Starting…" : `Run landing check · up to ~${price}`}
        </button>
        <span className="text-xs text-zinc-500">
          {website ? `Opens ${website} on a phone and a computer. It only costs anything if we need to look at the phone screenshot.` : "Add your website address to this project first."}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {audit && (
        <div className="flex flex-col gap-3 rounded-md border border-zinc-800 p-3">
          <p className="text-xs text-zinc-400" role="status">
            {running
              ? "Opening your page. This takes about a minute."
              : audit.status === "failed"
                ? `The last check couldn't finish: ${audit.error ?? "the page didn't load"}. The results before it still count.`
                : `Last checked ${when(audit.finishedAt ?? audit.createdAt)} · ${audit.passed ? "every must-pass check passed" : "some must-pass checks failed"}`}
          </p>
          {audit.checks.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {audit.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className={`mt-0.5 w-4 shrink-0 text-center ${c.passed ? "text-emerald-400" : c.severity === "gate" ? "text-rose" : "text-amber-300"}`}>
                    {c.passed ? "✓" : c.severity === "gate" ? "✕" : "!"}
                  </span>
                  <span className="flex flex-col">
                    <span>
                      {c.label}
                      <span className="sr-only">{c.passed ? " passed" : " failed"}</span>
                      <span className="ml-2 text-xs text-zinc-500">{c.severity === "gate" ? "must pass" : "advice"}</span>
                    </span>
                    {c.detail && <span className="text-xs text-zinc-400">{c.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {shots.length > 0 && (
            <div className="flex flex-wrap items-start gap-3">
              {shots.map((id, i) => (
                <figure key={id} className="flex flex-col gap-1">
                  <a href={`/api/media/${id}`} target="_blank" rel="noopener noreferrer" className="block max-w-full">
                    <img
                      src={`/api/media/${id}`}
                      alt={`Your landing page, first screen ${shotLabels[i]?.toLowerCase() ?? ""}`}
                      loading="lazy"
                      className={`max-w-full rounded border border-zinc-800 object-cover object-top ${shotLabels[i] === "On a phone" ? "h-72 w-36" : "h-48 w-80"}`}
                    />
                  </a>
                  <figcaption className="text-xs text-zinc-500">{shotLabels[i]}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
