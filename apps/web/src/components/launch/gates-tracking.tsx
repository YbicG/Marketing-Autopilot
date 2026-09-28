"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CopyButton } from "@/components/publishing/copy-button";
import { postJson } from "@/lib/post-json";

const BTN = "inline-flex min-h-11 md:min-h-9 items-center rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60";

/**
 * Tracking test gate: make a test link, open it logged out (private window or phone), then Check
 * now. It passes only when the site's own numbers show that visit; there is no tick box.
 */
export function TrackingTest({ slug, testUrl, passed }: { slug: string; testUrl: string | null; passed: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState(testUrl);
  const [busy, setBusy] = useState<"start" | "check" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  async function start() {
    if (busy !== null) return;
    setBusy("start");
    setMsg(null);
    const out = await postJson<{ url: string; alreadyPassed: boolean }>(`/api/launch/tracking/${encodeURIComponent(slug)}`, { action: "start" });
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "error", text: out.error });
    setUrl(out.data.url);
    router.refresh();
  }

  async function check() {
    if (busy !== null) return;
    setBusy("check");
    setMsg(null);
    const out = await postJson<{ passed: boolean; reasons: string[] }>(`/api/launch/tracking/${encodeURIComponent(slug)}`, { action: "check" });
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "error", text: out.error });
    setMsg(out.data.passed ? { tone: "ok", text: "Your site counted the visit. This check passed." } : { tone: "info", text: out.data.reasons.join(" ") || "No visit yet." });
    router.refresh();
  }

  if (passed && url) {
    return <p className="text-xs text-zinc-500">Your site counted a visit from the test link.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {!url ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void start()} disabled={busy !== null} className={BTN}>
            {busy === "start" ? "Making it…" : "Make a test link · free"}
          </button>
        </div>
      ) : (
        <>
          <p className="text-xs text-zinc-400">
            Open this link in a private window, or on your phone while logged out. Then come back and press Check now. It can take a few minutes for your site to count it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">{url}</code>
            <CopyButton text={url} label="Copy link" className={BTN} />
            <a href={url} target="_blank" rel="noopener noreferrer" className={BTN}>
              Open<span className="sr-only"> the test link (opens in a new tab)</span>
            </a>
            <button type="button" onClick={() => void check()} disabled={busy !== null} className={BTN}>
              {busy === "check" ? "Checking…" : "Check now"}
            </button>
            <button type="button" onClick={() => void start()} disabled={busy !== null} className="inline-flex min-h-11 items-center text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300 disabled:opacity-50 md:min-h-0">
              Make a new link
            </button>
          </div>
        </>
      )}
      <p role="status" className={`text-xs empty:hidden ${msg?.tone === "ok" ? "text-emerald-400" : msg?.tone === "error" ? "text-red-400" : "text-zinc-300"}`}>
        {msg?.text ?? ""}
      </p>
    </div>
  );
}
