"use client";
import { useState } from "react";
import { CopyButton } from "@/components/publishing/copy-button";
import { postJson } from "@/lib/post-json";

const primary = "rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

/**
 * Confirm on the agent spend page (D10). Mints a one-time code for exactly this request; the agent
 * sends it back with the same call. Nothing is spent until the agent does.
 */
export function ConfirmSpend({ tool, pat, input, price }: { tool: string; pat: string; input: string; price: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const out = await postJson<{ confirmToken: string }>("/api/tools/confirm", { tool, pat, input });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setCode(out.data.confirmToken);
  }

  if (code) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-emerald-900/70 bg-emerald-950/20 p-4">
        <p className="text-sm text-emerald-200">Confirmed. Give this code to your agent within 10 minutes. It works once, for this request only.</p>
        <code className="break-all rounded bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200">{code}</code>
        <CopyButton text={code} label="Copy code" className={`${primary} self-start`} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => void confirm()} disabled={busy} className={`${primary} self-start`}>
        {busy ? "Confirming…" : `Confirm up to ${price}`}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
