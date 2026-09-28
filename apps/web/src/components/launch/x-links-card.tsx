"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

interface XWindow {
  from: string;
  until: string;
}

const INPUT = "min-h-11 md:min-h-9 rounded-md border border-edge bg-zinc-900 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-zinc-400";
const BTN = "min-h-11 md:min-h-9 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60";

const nice = (d: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${d}T12:00:00Z`));

/**
 * X links in launch week (D24): the dates the Upload-Post X links add-on is on. Inside them X
 * posts carry their tracking link; outside them they point to the link in bio. Saving needs a
 * UI session because it lets links publish.
 */
export function XLinksCard({ slug, current, suggested, maxDays }: { slug: string; current: XWindow | null; suggested: XWindow; maxDays: number }) {
  const router = useRouter();
  const [from, setFrom] = useState(current?.from ?? suggested.from);
  const [until, setUntil] = useState(current?.until ?? suggested.until);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function send(body: unknown, okText: string) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const out = await postJson(`/api/launch/x-links/${encodeURIComponent(slug)}`, body);
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "error", text: out.error });
    setMsg({ tone: "ok", text: okText });
    router.refresh();
  }

  const unchanged = !!current && current.from === from && current.until === until;

  return (
    <section id="x-links" className="flex scroll-mt-4 flex-col gap-3 rounded-xl border border-zinc-800 p-5 bg-surface" aria-label="X links in launch week">
      <div>
        <h2 className="text-lg font-semibold">X links in launch week</h2>
        <p className="text-sm text-zinc-400">
          Posts on X can only carry a clickable link while Upload-Post&apos;s X links add-on ($19 a month) is on, so turn it on there for these dates only and off again after.
          Outside them, X posts point to the link in your bio.
        </p>
      </div>
      <p className="text-sm">
        {current ? (
          <>
            Now: <span className="font-medium">on from {nice(current.from)} to {nice(current.until)}</span>
          </>
        ) : (
          <span className="text-zinc-400">Now: off. X posts use the link in your bio.</span>
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send({ from, until }, "Saved. Turn the add-on on in Upload-Post for the same dates.");
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT} required />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          To
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={INPUT} required />
        </label>
        <button type="submit" disabled={busy || unchanged || !from || !until} className={BTN}>
          {busy ? "Saving…" : "Save"}
        </button>
        {current && (
          <button type="button" disabled={busy} onClick={() => void send({ off: true }, "Turned off. Turn the add-on off in Upload-Post too.")} className={BTN}>
            Turn off
          </button>
        )}
        {(from !== suggested.from || until !== suggested.until) && (
          <button
            type="button"
            onClick={() => {
              setFrom(suggested.from);
              setUntil(suggested.until);
            }}
            className="inline-flex min-h-11 items-center text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200 md:min-h-9"
          >
            Use launch week ({nice(suggested.from)} to {nice(suggested.until)})
          </button>
        )}
      </form>
      <p className="text-xs text-zinc-500">Suggested: launch day and three days either side. At most {maxDays} days.</p>
      <p role="status" className={`text-xs empty:hidden ${msg?.tone === "error" ? "text-red-400" : "text-emerald-400"}`}>
        {msg?.text ?? ""}
      </p>
    </section>
  );
}
