"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CopyButton } from "@/components/publishing/copy-button";
import { postJson } from "@/lib/post-json";
import { SCOPE_LABELS, setupLine, type Scope } from "./token-copy";

const input = "w-full rounded-md border border-edge bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-400";
const primary = "rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const quiet = "rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50";

/** Settings → Agent access → New token. The token comes back once and is shown with the setup line. */
export function NewTokenForm({ baseUrl }: { baseUrl: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read", "draft"]);
  const [days, setDays] = useState<string>("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const toggle = (s: Scope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !scopes.length) return;
    setBusy(true);
    setError(null);
    const out = await postJson<{ token: string }>("/api/settings/tokens", {
      action: "create",
      name: name.trim(),
      scopes,
      expiresInDays: days === "never" ? null : Number(days),
    });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setMade(out.data.token);
    setName("");
    router.refresh();
  }

  if (made) {
    const line = setupLine(baseUrl, made);
    return (
      <div className="flex flex-col gap-3 rounded-md border border-emerald-900/70 bg-emerald-950/20 p-4">
        <p className="text-sm text-emerald-200">Here&apos;s your token. Copy it now: it won&apos;t be shown again.</p>
        <code className="break-all rounded bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200">{made}</code>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={made} label="Copy token" />
          <CopyButton text={line} label="Copy setup line" />
        </div>
        <p className="text-sm text-zinc-400">To use it from Claude Code, run this in a terminal:</p>
        <code className="break-all rounded bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300">{line}</code>
        <button type="button" onClick={() => setMade(null)} className={`${quiet} self-start`}>
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={create} className="flex flex-col gap-4 rounded-md border border-zinc-800 p-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Claude Code on my laptop" className={input} disabled={busy} />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">What it may do</legend>
        {(Object.keys(SCOPE_LABELS) as Scope[]).map((s) => (
          <label key={s} className="flex min-h-11 items-start gap-3 text-sm md:min-h-0">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} disabled={busy} className="mt-1" />
            <span>
              <span className="font-medium">{SCOPE_LABELS[s].label}</span>
              <span className="block text-zinc-400">{SCOPE_LABELS[s].detail}</span>
            </span>
          </label>
        ))}
        <p className="text-xs text-zinc-500">No token can approve, post, or mark facts as checked. Those stay with you in the app.</p>
      </fieldset>
      <label className="flex flex-col gap-1.5 text-sm">
        <span>Stops working after</span>
        <select value={days} onChange={(e) => setDays(e.target.value)} className={input} disabled={busy}>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">A year</option>
          <option value="never">Never (until you revoke it)</option>
        </select>
      </label>
      <button type="submit" disabled={busy || !name.trim() || !scopes.length} className={`${primary} self-start`}>
        {busy ? "Making…" : "Make token"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}

export function RevokeButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function revoke() {
    if (!window.confirm(`Revoke "${name}"? Anything using it stops working straight away. This can't be undone.`)) return;
    setBusy(true);
    setError(null);
    const out = await postJson("/api/settings/tokens", { action: "revoke", id });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <button type="button" onClick={() => void revoke()} disabled={busy} className={quiet}>
        {busy ? "Revoking…" : "Revoke"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
