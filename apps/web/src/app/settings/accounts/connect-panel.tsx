"use client";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

export interface PlatformRow {
  platform: string;
  label: string;
  advice: string;
  /** Current connection status for this project, if any. */
  status: "active" | "reauth_required" | "revoked" | "error" | null;
  handle: string | null;
}

const primary = "rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const quiet = "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50";

const STATUS: Record<NonNullable<PlatformRow["status"]>, { text: string; tone: string }> = {
  active: { text: "Connected", tone: "text-emerald-400" },
  reauth_required: { text: "Needs reconnecting", tone: "text-amber-300" },
  revoked: { text: "Disconnected", tone: "text-zinc-500" },
  error: { text: "Problem", tone: "text-red-400" },
};

/** Wizard steps 2–3 for one project: its posting profile, then hosted connect links per platform. */
export function ConnectPanel({ productId, rows, disabled }: { productId: string; rows: PlatformRow[]; disabled: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect(platforms: string[], key: string) {
    setBusy(key);
    setError(null);
    const out = await postJson<{ url: string }>("/api/settings/accounts/connect", { productId, platforms });
    if (!out.ok) {
      setBusy(null);
      return setError(out.error);
    }
    // Upload-Post's hosted page sends CJ back to /settings/accounts?connected=1, which syncs.
    window.location.href = out.data.url;
  }

  const missing = rows.filter((r) => r.status !== "active").map((r) => r.platform);
  return (
    <div className="flex flex-col gap-3">
      {missing.length > 1 && (
        <div>
          <button type="button" className={primary} disabled={disabled || busy !== null} onClick={() => void connect(missing, "all")}>
            {busy === "all" ? "Opening…" : `Connect all ${missing.length}`}
          </button>
        </div>
      )}
      <ul className="flex flex-col divide-y divide-zinc-800 rounded-md border border-zinc-800">
        {rows.map((r) => {
          const st = r.status ? STATUS[r.status] : null;
          return (
            <li key={r.platform} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {r.label}
                  {st && <span className={`ml-2 text-xs font-normal ${st.tone}`}>{st.text}{r.handle ? ` · ${r.handle}` : ""}</span>}
                </p>
                <p className="text-xs text-zinc-400">{r.advice}</p>
              </div>
              {r.status !== "active" && (
                <button type="button" className={quiet} disabled={disabled || busy !== null} onClick={() => void connect([r.platform], r.platform)}>
                  {busy === r.platform ? "Opening…" : r.status ? "Reconnect" : "Connect"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

/** Wizard step 2: one Upload-Post profile per project (connecting also creates it, so this is optional). */
export function ProfileButton({ productId, ready, disabled }: { productId: string; ready: boolean; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);

  async function make() {
    setBusy(true);
    setError(null);
    const out = await postJson<{ profileRef: string }>("/api/settings/accounts/profile", { productId });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setProfile(out.data.profileRef);
  }

  if (ready || profile) return <span className="text-sm text-emerald-400">Profile ready{profile ? ` · ${profile}` : ""}</span>;
  return (
    <span className="flex flex-col gap-1">
      <button type="button" className={quiet} disabled={disabled || busy} onClick={() => void make()}>
        {busy ? "Creating…" : "Create profile"}
      </button>
      {error && <span className="text-sm text-red-400">{error}</span>}
    </span>
  );
}
