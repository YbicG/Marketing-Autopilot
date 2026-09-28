"use client";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

/**
 * "Download kit" (§8): the server re-checks the kit and refuses without its disclosures, so a
 * blocked reason shown here is advice; the refusal message from the server is the final word.
 */
export function KitDownload({ kitId, blockedReason, label = "Download kit" }: { kitId: string; blockedReason: string | null; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    const out = await postJson<{ href: string; files: string[] }>(`/api/launch/kits/${kitId}/export`, {});
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setFiles(out.data.files);
    window.location.assign(out.data.href);
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={busy || !!blockedReason}
        onClick={() => void download()}
        className="self-start rounded-lg bg-accent-strong px-3 py-1.5 text-sm font-medium text-zinc-50 disabled:opacity-50 hover:bg-accent"
      >
        {busy ? "Putting it together…" : label}
      </button>
      {blockedReason && <p className="text-sm text-amber-300">{blockedReason}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {files && <p className="text-xs text-zinc-500">Downloading {files.length} files as one zip.</p>}
    </div>
  );
}
