"use client";
import type { KitKind } from "@mkt/contracts";
import { emptyTarget, OUTLET_LABEL, OUTLET_TYPES, type InputDraft, type PressTargetDraft } from "./kit-model";

const input = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm";
const labelCls = "flex flex-col gap-1 text-sm text-zinc-300";
const hint = "text-xs text-zinc-500";

/** What each part of the kit can take before it's written (all optional; blanks become [placeholders]). */
export function KitInputFields({ kind, draft, onChange }: { kind: KitKind; draft: InputDraft; onChange: (d: InputDraft) => void }) {
  const set = <K extends keyof InputDraft>(k: K, v: InputDraft[K]) => onChange({ ...draft, [k]: v });
  switch (kind) {
    case "subreddit":
      return (
        <div className="flex flex-col gap-3">
          <label className={labelCls}>
            Communities (one per line)
            <textarea rows={4} value={draft.communities} onChange={(e) => set("communities", e.target.value)} placeholder={"college\nUCLA\nstudents"} className={input} />
            <span className={hint}>Leave it empty and we&apos;ll suggest some for you to check.</span>
          </label>
          <label className={labelCls}>
            Day to post
            <input type="date" value={draft.dueDate} onChange={(e) => set("dueDate", e.target.value)} className={`${input} max-w-48`} />
            <span className={hint}>Empty means launch day.</span>
          </label>
        </div>
      );
    case "ambassador":
      return (
        <div className="flex flex-col gap-3">
          <label className={labelCls}>
            Ambassadors (one per line: name, or name, link code)
            <textarea rows={4} value={draft.ambassadors} onChange={(e) => set("ambassadors", e.target.value)} placeholder={"Maya Chen\nJordan Lee, jordan-ucla"} className={input} />
            <span className={hint}>Each gets their own link. Leave the code out and we&apos;ll make one from the name.</span>
          </label>
          <label className={labelCls}>
            What ambassadors get
            <input value={draft.reward} onChange={(e) => set("reward", e.target.value)} placeholder="A free year of the full plan" className={input} />
            <span className={hint}>In your words. We never make this up; empty leaves a spot for you to fill in.</span>
          </label>
        </div>
      );
    case "press":
      return <PressTargets targets={draft.targets} onChange={(t) => set("targets", t)} />;
    case "creator":
      return (
        <label className={labelCls}>
          What you offer creators
          <input value={draft.offer} onChange={(e) => set("offer", e.target.value)} placeholder="Free lifetime plan plus $50 for one video" className={input} />
          <span className={hint}>In your words. Empty leaves a spot for you to fill in. You send every message yourself.</span>
        </label>
      );
    case "reply_bank":
      return (
        <label className={labelCls}>
          Questions you expect on launch day (one per line)
          <textarea rows={4} value={draft.extraQuestions} onChange={(e) => set("extraQuestions", e.target.value)} placeholder={"Does it work with Outlook?\nIs my syllabus kept private?"} className={input} />
          <span className={hint}>We add the common ones anyway.</span>
        </label>
      );
    default:
      return <p className={hint}>Nothing to fill in. It&apos;s written from your plan and your finished posts.</p>;
  }
}

function PressTargets({ targets, onChange }: { targets: PressTargetDraft[]; onChange: (t: PressTargetDraft[]) => void }) {
  const rows = targets.length ? targets : [emptyTarget()];
  const edit = (i: number, patch: Partial<PressTargetDraft>) => onChange(rows.map((t, n) => (n === i ? { ...t, ...patch } : t)));
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-zinc-300">Newsletters, papers and podcasts to pitch</p>
      <p className={hint}>Only real ones you know. Without them the pitches say [Outlet] and [Editor first name] for you to fill in.</p>
      {rows.map((t, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded-md border border-zinc-800 p-2 sm:grid-cols-[2fr_1.3fr_1.3fr_1.6fr_auto]">
          <input aria-label="Name of the newsletter, paper or podcast" placeholder="The Daily Bruin" value={t.outlet} onChange={(e) => edit(i, { outlet: e.target.value })} className={input} />
          <select aria-label="Kind" value={t.kind} onChange={(e) => edit(i, { kind: e.target.value as PressTargetDraft["kind"] })} className={input}>
            {OUTLET_TYPES.map((k) => (
              <option key={k} value={k}>
                {OUTLET_LABEL[k]}
              </option>
            ))}
          </select>
          <input aria-label="Who to write to" placeholder="Editor's name" value={t.contactName} onChange={(e) => edit(i, { contactName: e.target.value })} className={input} />
          <input aria-label="Their email" type="email" placeholder="Email" value={t.email} onChange={(e) => edit(i, { email: e.target.value })} className={input} />
          <button type="button" onClick={() => onChange(rows.filter((_, n) => n !== i))} className="rounded-md px-2 text-xs text-zinc-500 hover:text-zinc-200">
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, emptyTarget()])} className="self-start text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
        Add another
      </button>
    </div>
  );
}
