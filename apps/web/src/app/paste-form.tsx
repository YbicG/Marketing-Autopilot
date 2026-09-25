"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function PasteForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
    if (!res.ok || !body.runId) {
      setError(body.error ?? "Couldn't start. Try again.");
      setBusy(false);
      return;
    }
    router.push(`/runs/${body.runId}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a link, like syllacal.com"
          aria-label="Link to your product"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5 outline-none focus:border-zinc-600"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="shrink-0 rounded-md bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
        >
          {busy ? "Starting…" : "Read my product"}
        </button>
      </div>
      <p className="text-xs text-zinc-500">~$0.02 · under a minute · you can close this tab</p>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
