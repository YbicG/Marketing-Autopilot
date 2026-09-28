"use client";
import { useState } from "react";

export function DeleteWorkspace() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (busy || text.trim() !== "delete") return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings/delete-workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: text.trim() }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Couldn't delete.");
      setBusy(false);
      return;
    }
    window.location.href = "/signin";
  }

  return (
    <form onSubmit={go} className="flex flex-col gap-2">
      <input
        value={text}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        placeholder='Type "delete"'
        aria-label="Type delete to confirm"
        className="min-h-11 md:min-h-9 rounded-md border border-edge bg-zinc-900 px-3 py-2 outline-none focus:border-zinc-400 disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={busy || text.trim() !== "delete"}
        className="min-h-11 md:min-h-9 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-red-800 disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Delete workspace"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
