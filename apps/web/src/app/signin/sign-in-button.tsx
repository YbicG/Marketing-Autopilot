"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignInButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signIn.social({ provider: "github", callbackURL: "/" });
      if (!res.error) return; // the browser is on its way to GitHub
      setError(res.error.message ?? "Sign-in failed.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="min-h-11 rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-zinc-50 hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
