"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

export interface OptionalVenue {
  key: string;
  title: string;
  detail: string;
  /** "Mon, Nov 16" */
  due: string;
}

/**
 * No plan yet (§2.3 Launch): the dates the checklist will be worked back from, and the optional
 * venues (off by default, open question 4) to switch on before it's made. Free: no Claude call.
 */
export function PlanStart({
  slug,
  start,
  launch,
  end,
  optional,
}: {
  slug: string;
  start: string;
  launch: string;
  end: string;
  optional: OptionalVenue[];
}) {
  const router = useRouter();
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function flip(key: string) {
    setOn((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function make() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/launch/plan/${encodeURIComponent(slug)}`, { action: "create", optionalOn: [...on] });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-zinc-800 p-5 bg-surface" aria-label="Make my launch checklist">
      <div>
        <h2 className="text-lg font-semibold">Make my launch checklist</h2>
        <p className="text-sm text-zinc-400">
          Every step for the 30 days, worked back from your launch day. The app does the Auto steps; you tick the rest. Four checks on your site have to pass before launch
          day posts go out.
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        {[
          ["Day 1", start],
          ["Launch day", launch],
          ["Day 30", end],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md border border-zinc-800 px-3 py-2">
            <dt className="text-xs text-zinc-500">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="-mt-3 text-xs text-zinc-500">These come from your current campaign. To move launch day, change it on the Plan tab.</p>

      {optional.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Extra places to launch (off unless you want them)</legend>
          {optional.map((o) => (
            <label key={o.key} className="flex cursor-pointer items-start gap-3 rounded-md border border-zinc-800 px-3 py-2 hover:border-zinc-700">
              <input type="checkbox" checked={on.has(o.key)} onChange={() => flip(o.key)} className="mt-1 accent-zinc-200" />
              <span className="flex flex-col">
                <span className="text-sm">
                  {o.title} <span className="text-zinc-500">· by {o.due}</span>
                </span>
                <span className="text-xs text-zinc-500">{o.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void make()}
          disabled={busy}
          className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-accent disabled:opacity-60"
        >
          {busy ? "Making it…" : "Make my launch checklist · free"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </section>
  );
}
