"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { EmailIssue } from "@mkt/contracts";
import type { BroadcastView } from "@mkt/core/email";
import { postJson } from "@/lib/post-json";
import { sendTime, tzName } from "./labels";

const input = "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600 disabled:opacity-60";
const primary = "rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const quiet = "rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50";
const PREVIEW_DEBOUNCE_MS = 500;

type Busy = "save" | "approve" | "void" | "cancel" | "retry" | "audience" | null;

export interface EditorProps {
  slug: string;
  tz: string;
  view: BroadcastView;
  initialDay: string;
  initialTime: string;
  /** The list picked in sender settings, offered when this email points at another (or none). */
  settingsAudience: { id: string; label: string | null } | null;
  missing: string[];
}

function Issues({ issues }: { issues: EmailIssue[] }) {
  if (!issues.length) return <p className="text-sm text-emerald-400">No problems found.</p>;
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1));
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {sorted.map((i) => (
        <li key={`${i.code}-${i.message}`} className={i.severity === "block" ? "text-red-300" : "text-amber-300"}>
          <span className="mr-1 font-medium">{i.severity === "block" ? "Must fix:" : "Check:"}</span>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * The seasonal email editor (§5.4 Email): subject, preheader and body, a live preview of the exact
 * HTML in a sandboxed iframe (sandbox="" and no allow-same-origin, so nothing in it can run or reach
 * the app), the §8 checks, the send time, and Approve & schedule (D9: a UI session only).
 */
export function BroadcastEditor({ slug, tz, view, initialDay, initialTime, settingsAudience, missing }: EditorProps) {
  const router = useRouter();
  const [subject, setSubject] = useState(view.subject);
  const [preheader, setPreheader] = useState(view.preheader ?? "");
  const [body, setBody] = useState(view.body);
  const [day, setDay] = useState(initialDay);
  const [time, setTime] = useState(initialTime);
  const [draftPreview, setDraftPreview] = useState<{ html: string; issues: EmailIssue[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const contentDirty = subject !== view.subject || preheader !== (view.preheader ?? "") || body !== view.body;
  const scheduleDirty = day !== initialDay || time !== initialTime;
  const dirty = contentDirty || scheduleDirty;
  const live = view.status === "approved" || view.status === "scheduled_at_resend";
  const readOnly = !view.canEdit;
  const api = `/api/email/broadcasts/${view.id}`;

  // Live preview of unsaved text; nothing is saved (so typing never takes it back from Resend).
  useEffect(() => {
    if (!contentDirty) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setPreviewing(true);
      const out = await postJson<{ html: string; issues: EmailIssue[] }>(`${api}/preview`, { subject, preheader: preheader || null, body });
      if (n !== seq.current) return;
      setPreviewing(false);
      if (out.ok) setDraftPreview({ html: out.data.html, issues: out.data.issues });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [api, contentDirty, subject, preheader, body]);
  const preview = contentDirty && draftPreview ? draftPreview : { html: view.preview.html, issues: view.issues };

  async function run(kind: Exclude<Busy, null>, url: string, payload: unknown = {}) {
    setBusy(kind);
    setError(null);
    const out = await postJson(url, payload);
    setBusy(null);
    if (!out.ok) {
      setError(out.error);
      return false;
    }
    router.refresh();
    return true;
  }

  async function save() {
    if (live && !window.confirm("Saving this change takes the email back from Resend. It won't send until you approve it again. Save anyway?")) return;
    const payload: Record<string, unknown> = {};
    if (contentDirty) Object.assign(payload, { subject, preheader: preheader || null, body });
    if (scheduleDirty) payload.schedule = day && time ? { day, time } : null;
    await run("save", `${api}/save`, payload);
  }

  async function pickSettingsAudience() {
    if (!settingsAudience) return;
    if (live && !window.confirm("Changing the list takes the email back from Resend. It won't send until you approve it again. Change it?")) return;
    await run("audience", `${api}/save`, { audienceId: settingsAudience.id, audienceLabel: settingsAudience.label });
  }

  async function approve() {
    // A refused approval stores the fresh checks on the row, so the refresh shows them either way.
    if (!(await run("approve", `${api}/approve`))) router.refresh();
  }

  async function takeBack() {
    if (!window.confirm("Take this email back? It's canceled at Resend and waits for your approval again.")) return;
    await run("void", `${api}/void`);
  }

  async function cancel() {
    if (!window.confirm("Cancel this email for good? If Resend has it scheduled, it's canceled there too. You can write a new one afterwards.")) return;
    await run("cancel", `${api}/cancel`);
  }

  const when = sendTime(view.scheduledAt, tz);
  const blocks = preview.issues.filter((i) => i.severity === "block");
  const audienceDiffers = !!settingsAudience && settingsAudience.id !== view.audienceId;
  const approveBlockers = [
    dirty && "Save your changes first.",
    missing.length > 0 && "Finish the sender settings on the Email page.",
    !view.audienceId && "Pick which list it goes to.",
    !view.scheduledAt && "Pick a send time and save.",
    blocks.length > 0 && "Fix everything marked “Must fix”.",
  ].filter((x): x is string => typeof x === "string");

  return (
    <div className="flex flex-col gap-6">
      {view.status === "approved" && (
        <p className="rounded-md border border-sky-900/70 bg-sky-950/20 px-4 py-3 text-sm text-sky-200">
          Approved. It&apos;s on its way to Resend to be scheduled{when ? ` for ${when}` : ""}. Editing it now takes it back, and it needs your approval
          again.
        </p>
      )}
      {view.status === "scheduled_at_resend" && (
        <p className="rounded-md border border-sky-900/70 bg-sky-950/20 px-4 py-3 text-sm text-sky-200">
          Scheduled at Resend{when ? ` for ${when} (${tzName(tz)} time)` : ""}. Editing it takes it back from Resend, and it needs your approval again.
        </p>
      )}
      {view.status === "failed" && (
        <div className="flex flex-col gap-2 rounded-md border border-red-900/70 bg-red-950/20 px-4 py-3 text-sm text-red-200">
          <p>It didn&apos;t go out. {view.lastError ?? "Resend refused it."}</p>
          <button type="button" onClick={() => void run("retry", `${api}/retry`)} disabled={busy !== null} className={`${quiet} self-start`}>
            {busy === "retry" ? "Working…" : "Try again (back to approval)"}
          </button>
        </div>
      )}
      {view.status === "pending_approval" && view.lastError && (
        <p className="rounded-md border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">{view.lastError}</p>
      )}
      {view.status === "draft" && view.lastError && (
        <p className="rounded-md border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
          {view.lastError} You can also write it yourself below and save.
        </p>
      )}
      {view.status === "sent" && (
        <div className="rounded-md border border-emerald-900/70 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-200">
          <p>Sent{view.sentAt ? ` ${sendTime(view.sentAt, tz)}` : ""}.</p>
          {view.lastError && <p className="mt-1 text-amber-200">{view.lastError}</p>}
          {view.stats && (
            <dl className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {(
                [
                  ["Sent", view.stats.sent],
                  ["Delivered", view.stats.delivered],
                  ["Opened", view.stats.opened],
                  ["Tapped the link", view.stats.clicked],
                  ["Bounced", view.stats.bounced],
                  ["Marked as spam", view.stats.complained],
                ] as const
              ).map(([k, n]) => (
                <div key={k}>
                  <dt className="text-xs text-emerald-300/70">{k}</dt>
                  <dd className="text-base font-medium">{n}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {view.status === "canceled" && <p className="rounded-md border border-zinc-800 px-4 py-3 text-sm text-zinc-400">Canceled. It won&apos;t be sent.</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-4" aria-label="Edit the email">
          <label className="flex flex-col gap-1 text-sm">
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} disabled={readOnly} className={input} />
            <span className="text-xs text-zinc-500">{subject.length}/60 characters is a good length. Say plainly what&apos;s inside.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>
              Preview line <span className="text-zinc-500">(the grey text inboxes show after the subject)</span>
            </span>
            <input value={preheader} onChange={(e) => setPreheader(e.target.value)} maxLength={200} disabled={readOnly} className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Email</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} disabled={readOnly} className={`${input} font-[inherit] leading-relaxed`} />
            <span className="text-xs text-zinc-500">
              Leave a blank line between paragraphs. Put <code className="text-zinc-300">{"{{link:landing}}"}</code> where the link goes: it becomes a
              tracking link to your website. Don&apos;t paste web addresses, and skip the footer: it&apos;s added for you.
            </span>
          </label>

          <div className="flex flex-col gap-1 text-sm">
            <span>
              Send time <span className="text-zinc-500">({tzName(tz)} time)</span>
            </span>
            <div className="flex flex-wrap gap-2">
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} disabled={readOnly} aria-label="Send day" className={`${input} w-auto`} />
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={readOnly} aria-label="Send time" className={`${input} w-auto`} />
            </div>
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <span>Goes to</span>
            <p className="text-zinc-300">{view.audienceLabel ?? view.audienceId ?? <span className="text-amber-300">No list picked yet</span>}</p>
            {audienceDiffers && !readOnly && (
              <button type="button" onClick={() => void pickSettingsAudience()} disabled={busy !== null} className={`${quiet} self-start`}>
                {busy === "audience" ? "Saving…" : `Send to ${settingsAudience!.label ?? settingsAudience!.id} instead`}
              </button>
            )}
            {!settingsAudience && (
              <p className="text-xs text-zinc-500">
                Pick a Resend list in the sender settings on the{" "}
                <Link href={`/p/${encodeURIComponent(slug)}/email`} className="underline underline-offset-2">
                  Email page
                </Link>
                .
              </p>
            )}
          </div>

          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void save()} disabled={!dirty || busy !== null} className={primary}>
                {busy === "save" ? "Saving…" : live ? "Save (takes it back from Resend)" : "Save"}
              </button>
              {dirty && (
                <button
                  type="button"
                  onClick={() => {
                    setSubject(view.subject);
                    setPreheader(view.preheader ?? "");
                    setBody(view.body);
                    setDay(initialDay);
                    setTime(initialTime);
                  }}
                  disabled={busy !== null}
                  className={quiet}
                >
                  Undo changes
                </button>
              )}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-label="Preview">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-semibold">Preview</h2>
            <span className="text-xs text-zinc-500">{previewing ? "Updating…" : contentDirty ? "Unsaved changes" : "As it will be sent"}</span>
          </div>
          <p className="text-xs text-zinc-400">
            From {view.preview.from ?? <span className="text-amber-300">no sender yet</span>}
            {view.preview.replyTo ? ` · replies to ${view.preview.replyTo}` : ""}
          </p>
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[560px] w-full rounded-md border border-zinc-800 bg-white" />
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Checks</h3>
            <Issues issues={preview.issues} />
          </div>
        </section>
      </div>

      <section className="flex flex-col gap-3 border-t border-zinc-800 pt-4" aria-label="Approve">
        {view.status === "pending_approval" && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void approve()} disabled={busy !== null || approveBlockers.length > 0} className={primary}>
                {busy === "approve" ? "Approving…" : "Approve & schedule"}
              </button>
              {when && approveBlockers.length === 0 && (
                <span className="text-sm text-zinc-400">
                  Sends {when} ({tzName(tz)} time) to {view.audienceLabel ?? "your list"}.
                </span>
              )}
            </div>
            {approveBlockers.length > 0 && (
              <ul className="list-disc pl-5 text-sm text-zinc-400">
                {approveBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {view.status === "draft" && !view.subject && !view.body && <p className="text-sm text-zinc-400">Once it&apos;s written, check it here and approve it.</p>}
        <div className="flex flex-wrap gap-2">
          {live && (
            <button type="button" onClick={() => void takeBack()} disabled={busy !== null} className={quiet}>
              {busy === "void" ? "Taking back…" : "Take back"}
            </button>
          )}
          {view.canCancel && (
            <button type="button" onClick={() => void cancel()} disabled={busy !== null} className={`${quiet} hover:border-red-800 hover:text-red-300`}>
              {busy === "cancel" ? "Canceling…" : "Cancel this email"}
            </button>
          )}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </section>
    </div>
  );
}
