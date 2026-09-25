"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/post-json";

export interface HealthRow {
  id: string;
  productId: string | null;
  project: string;
  platform: string;
  platformLabel: string;
  handle: string | null;
  status: "active" | "reauth_required" | "revoked" | "error";
  tokenExpires: string;
  lastCheck: string;
  maxPerDay: number;
  shared: boolean;
}

const quiet = "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50";

const STATUS: Record<HealthRow["status"], { text: string; tone: string }> = {
  active: { text: "Active", tone: "text-emerald-400" },
  reauth_required: { text: "Needs reconnecting", tone: "text-amber-300" },
  revoked: { text: "Disconnected", tone: "text-zinc-500" },
  error: { text: "Problem", tone: "text-red-400" },
};

/** Coming back from a hosted connect link (?connected=1): read the new accounts once, then clean the URL. */
export function SyncOnReturn() {
  const router = useRouter();
  const done = useRef(false);
  const [msg, setMsg] = useState("Checking which accounts you connected…");
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void postJson<{ accounts: number; problems: string[] }>("/api/settings/accounts/sync", {}).then((out) => {
      if (!out.ok) return setMsg(out.error);
      setMsg(out.data.problems.length ? out.data.problems.join(" ") : "Accounts updated.");
      router.replace("/settings/accounts");
      router.refresh();
    });
  }, [router]);
  return <p className="rounded-md border border-sky-900/70 bg-sky-950/20 px-4 py-3 text-sm text-sky-200">{msg}</p>;
}

/** The health list: status, token expiry, last check and the per-account daily limit. */
export function HealthList({ rows }: { rows: HealthRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, url: string, body: unknown, ok: string) {
    setBusy(key);
    setError(null);
    setNote(null);
    const out = await postJson(url, body);
    setBusy(null);
    if (!out.ok) return setError(out.error);
    setNote(ok);
    router.refresh();
  }

  async function reconnect(r: HealthRow) {
    if (!r.productId) return;
    setBusy(r.id);
    setError(null);
    const out = await postJson<{ url: string }>("/api/settings/accounts/connect", { productId: r.productId, platforms: [r.platform] });
    if (!out.ok) {
      setBusy(null);
      return setError(out.error);
    }
    window.location.href = out.data.url;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={quiet}
          disabled={busy !== null}
          onClick={() => void run("check", "/api/settings/accounts/check", {}, "Checking in the background. Refresh in a minute to see the results.")}
        >
          {busy === "check" ? "Starting…" : "Check now"}
        </button>
        <button type="button" className={quiet} disabled={busy !== null} onClick={() => void run("sync", "/api/settings/accounts/sync", {}, "Accounts updated.")}>
          {busy === "sync" ? "Refreshing…" : "Refresh accounts"}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No accounts connected yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-800">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-zinc-900/60 text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Sign-in expires</th>
                <th className="px-3 py-2 font-medium">Last checked</th>
                <th className="px-3 py-2 font-medium">Posts a day</th>
                <th className="px-3 py-2 font-medium">Shared</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map((r) => {
                const st = STATUS[r.status];
                return (
                  <tr key={r.id}>
                    <td className="px-3 py-2">
                      <p>
                        {r.platformLabel}
                        {r.handle && <span className="text-zinc-400"> · {r.handle}</span>}
                      </p>
                      <p className="text-xs text-zinc-500">{r.project}</p>
                    </td>
                    <td className="px-3 py-2">
                      <span className={st.tone}>{st.text}</span>
                      {(r.status === "reauth_required" || r.status === "revoked" || r.status === "error") && r.productId && (
                        <button type="button" className="ml-2 text-xs underline underline-offset-2" disabled={busy !== null} onClick={() => void reconnect(r)}>
                          {busy === r.id ? "Opening…" : "Reconnect"}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{r.tokenExpires}</td>
                    <td className="px-3 py-2 text-zinc-300">{r.lastCheck}</td>
                    <td className="px-3 py-2">
                      <select
                        value={r.maxPerDay}
                        aria-label={`Posts a day on ${r.platformLabel}`}
                        disabled={busy !== null}
                        onChange={(e) => void run(r.id, "/api/settings/accounts/limits", { id: r.id, maxPerDay: Number(e.target.value) }, "Saved.")}
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1"
                      >
                        {[1, 2, 3].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={r.shared}
                        aria-label={`${r.platformLabel} account is shared across projects`}
                        disabled={busy !== null}
                        onChange={(e) => void run(r.id, "/api/settings/accounts/limits", { id: r.id, shared: e.target.checked }, "Saved.")}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-zinc-500">
        Shared means one personal account posts for several projects, so its daily limit counts across all of them. TikTok stays at 1 a day in
        its first week and never goes above 2.
      </p>
      {note && !error && <p className="text-sm text-emerald-400">{note}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
