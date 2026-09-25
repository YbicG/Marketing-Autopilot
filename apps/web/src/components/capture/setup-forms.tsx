"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

export const field = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-zinc-400 focus:outline-none disabled:opacity-60";
export const primary = "rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
export const secondary = "rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400 disabled:opacity-50";

type Msg = { tone: "ok" | "err"; text: string } | null;
const Note = ({ msg }: { msg: Msg }) => (msg ? <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-400" : "text-amber-300"}`}>{msg.text}</p> : null);

/** The demo site's internal address and the pages the recorder must never open. */
export function OriginForm({ slug, origin, denylist, suggestion }: { slug: string; origin: string | null; denylist: string[]; suggestion: string[] }) {
  const router = useRouter();
  const [value, setValue] = useState(origin ?? "");
  const [routes, setRoutes] = useState(denylist.join("\n"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const list = routes
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const missing = suggestion.filter((x) => !list.includes(x));

  async function save(nextOrigin: string | null) {
    setBusy(true);
    setMsg(null);
    const out = await postJson<{ origin: string | null; denylist: string[] }>(`/api/capture/${encodeURIComponent(slug)}/origin`, { origin: nextOrigin, denylist: list });
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    setValue(out.data.origin ?? "");
    setRoutes(out.data.denylist.join("\n"));
    setMsg({ tone: "ok", text: out.data.origin ? "Saved." : "Saved. Recording is off until you add an address." });
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-800 p-4" aria-label="Demo site">
      <h2 className="font-semibold">Demo site</h2>
      <p className="text-sm text-zinc-400">
        The recorder only opens one site: a demo copy of your app that runs next to this one on your server. Use its internal address, the service name and port, like{" "}
        <code className="text-zinc-200">http://syllacal-demo:3000</code>. A public web address won't work, so a recording can never touch your live app or real customers.
      </p>
      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        Internal address
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="http://syllacal-demo:3000" className={field} disabled={busy} spellCheck={false} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        Pages and calls it must never open, one per line (payments, emails, anything that costs money)
        <textarea value={routes} onChange={(e) => setRoutes(e.target.value)} rows={5} className={`${field} font-mono text-xs`} disabled={busy} spellCheck={false} placeholder="/api/checkout" />
        <span>
          Use <code>*</code> for any part of one segment and <code>**</code> for any number of segments.
        </span>
      </label>
      {missing.length > 0 && (
        <button type="button" onClick={() => setRoutes([...list, ...missing].join("\n"))} disabled={busy} className="self-start text-xs text-zinc-300 underline underline-offset-2">
          Add the suggested ones for SyllaCal ({missing.length})
        </button>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save(value.trim() || null)} disabled={busy} className={primary}>
          {busy ? "Saving…" : "Save"}
        </button>
        {origin && (
          <button type="button" onClick={() => void save(null)} disabled={busy} className="text-sm text-zinc-400 underline underline-offset-2">
            Turn recording off
          </button>
        )}
        <Note msg={msg} />
      </div>
    </section>
  );
}

/** Demo account login. Write-only: what's saved is never sent back to the browser. */
export function LoginForm({ slug, hasLogin }: { slug: string; hasLogin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(!hasLogin);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginPath, setLoginPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const out = await postJson(`/api/capture/${encodeURIComponent(slug)}/login`, { username, password, ...(loginPath.trim() ? { loginPath: loginPath.trim() } : {}) });
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    setUsername("");
    setPassword("");
    setOpen(false);
    setMsg({ tone: "ok", text: "Saved. It's stored encrypted and never shown again." });
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-800 p-4" aria-label="Demo login">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Demo login</h2>
        <span className={`text-xs ${hasLogin ? "text-emerald-400" : "text-zinc-500"}`}>{hasLogin ? "Saved" : "Not set"}</span>
      </div>
      <p className="text-sm text-zinc-400">
        For flows that need to be signed in. Use a demo account with sample data only, never a real customer's. The login happens before recording starts, so it never shows in a video.
      </p>
      {open ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Email or username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className={field} disabled={busy} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={field} disabled={busy} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Sign-in page (optional)
            <input value={loginPath} onChange={(e) => setLoginPath(e.target.value)} placeholder="/login" className={field} disabled={busy} spellCheck={false} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy || !username.trim() || !password} className={primary}>
              {busy ? "Saving…" : hasLogin ? "Replace login" : "Save login"}
            </button>
            {hasLogin && (
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-zinc-400 underline underline-offset-2">
                Cancel
              </button>
            )}
            <Note msg={msg} />
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setOpen(true)} className={secondary}>
            Replace login
          </button>
          <Note msg={msg} />
        </div>
      )}
    </section>
  );
}
