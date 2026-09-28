"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

const BTN = "min-h-11 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-50 md:min-h-7";

/**
 * Row controls for the checklist. "You" and "Assisted" rows get Mark done / Skip (and Undo);
 * optional rows get an on/off switch. Gates and Auto rows have none: checks and the app move them.
 */
export function TaskActions({
  taskId,
  status,
  tickable,
  optional,
  blocked,
}: {
  taskId: string;
  status: string;
  /** "You" / "Assisted" rows whose status the person owns. */
  tickable: boolean;
  optional: boolean;
  /** Waiting on a check or another task: Mark done is refused until that passes. */
  blocked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await postJson(url, body);
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }
  const setStatus = (s: "done" | "skipped" | "todo") => send(`/api/launch/tasks/${taskId}/status`, { status: s });
  const toggle = (on: boolean) => send(`/api/launch/tasks/${taskId}/optional`, { on });

  const off = optional && status === "skipped";
  const finished = status === "done" || status === "skipped";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {optional && status !== "done" && (
          <button type="button" role="switch" aria-checked={!off} disabled={busy} onClick={() => void toggle(off)} className={BTN}>
            {off ? "Turn on" : "Turn off"}
          </button>
        )}
        {tickable && !off && !finished && (
          <>
            <button
              type="button"
              disabled={busy || blocked}
              onClick={() => void setStatus("done")}
              title={blocked ? "Finish what this waits on first." : undefined}
              className={BTN}
            >
              Mark done
            </button>
            {!optional && (
              <button type="button" disabled={busy} onClick={() => void setStatus("skipped")} className={BTN}>
                Skip
              </button>
            )}
          </>
        )}
        {tickable && finished && !off && (
          <button type="button" disabled={busy} onClick={() => void setStatus("todo")} className={BTN}>
            Undo
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** Re-date and re-check the checklist now (launch.tick does this hourly anyway). */
export function PlanRefresh({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/launch/plan/${encodeURIComponent(slug)}`, { action: "refresh" });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={() => void refresh()} disabled={busy} className="min-h-11 md:min-h-9 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-60">
        {busy ? "Checking…" : "Check again"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
