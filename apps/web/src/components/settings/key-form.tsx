"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

const input = "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600";
const primary = "rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const quiet = "rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50";

/**
 * Add or replace one vault secret. The value only ever travels browser → server; the page never
 * receives it back, so the field starts empty every time.
 */
export function KeyForm({ purpose, label, stored, disabled }: { purpose: string; label: string; stored: boolean; disabled?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    const out = await postJson("/api/settings/keys", { action: "put", purpose, value: value.trim() });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setValue("");
    setSaved(true);
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Remove the saved ${label.toLowerCase()}? Anything that uses it stops until you add it again.`)) return;
    setBusy(true);
    setError(null);
    const out = await postJson("/api/settings/keys", { action: "delete", purpose });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setSaved(false);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={stored ? `Paste a new ${label.toLowerCase()} to replace it` : `Paste your ${label.toLowerCase()}`}
          aria-label={label}
          disabled={disabled || busy}
          className={input}
        />
        <button type="submit" disabled={disabled || busy || !value.trim()} className={primary}>
          {busy ? "Saving…" : stored ? "Replace" : "Save"}
        </button>
        {stored && (
          <button type="button" onClick={() => void remove()} disabled={busy} className={quiet}>
            Remove
          </button>
        )}
      </div>
      {saved && !error && <p className="text-xs text-emerald-400">Saved. It&apos;s encrypted and won&apos;t be shown again.</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}

/** Demo test login for capture (D26). Username and password go into the vault as one JSON secret. */
export function LoginForm({ productId, stored, disabled }: { productId: string; stored: boolean; disabled?: boolean }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginPath, setLoginPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const out = await postJson("/api/settings/keys", {
      action: "put_login",
      productId,
      username: username.trim(),
      password,
      ...(loginPath.trim() ? { loginPath: loginPath.trim() } : {}),
    });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setUsername("");
    setPassword("");
    setLoginPath("");
    router.refresh();
  }

  async function remove() {
    if (!window.confirm("Remove this test login? Recorded demos stop until you add it again.")) return;
    setBusy(true);
    const out = await postJson("/api/settings/keys", { action: "delete", purpose: `capture.login.${productId}` });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }

  const off = disabled || busy;
  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="Test username or email" aria-label="Test username" disabled={off} className={input} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Test password" aria-label="Test password" disabled={off} className={input} />
        <input value={loginPath} onChange={(e) => setLoginPath(e.target.value)} autoComplete="off" placeholder="Sign-in page, e.g. /login (optional)" aria-label="Sign-in page path" disabled={off} className={input} />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={off || !username.trim() || !password} className={primary}>
          {busy ? "Saving…" : stored ? "Replace login" : "Save login"}
        </button>
        {stored && (
          <button type="button" onClick={() => void remove()} disabled={busy} className={quiet}>
            Remove
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
