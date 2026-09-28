"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  PRESS_OUTLET_TYPES,
  type AmbassadorKitBody,
  type CreatorKitBody,
  type KitDisclosure,
  type KitMessageTemplate,
  type LaunchKitBody,
  type PressKitBody,
  type ReplyBankBody,
  type SubredditKitBody,
} from "@mkt/contracts";
import { CopyButton } from "@/components/publishing/copy-button";
import { postJson } from "@/lib/post-json";
import { ItemList, Section, StringList, TextField } from "./kit-fields";
import { OUTLET_LABEL, redditRulesUrl, subredditOf } from "./kit-model";

const LINK_HINT = "Leave {{link:landing}} as it is: it becomes your tracking link in the download.";
const REPLY_MAX = 500;
const REDDIT_TITLE_MAX = 300;
const selectCls = "rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm";

/**
 * Edit a kit's body (§5.4 LC launch kit). Saving sends the whole body back; the server parses it
 * with the kind's schema and runs every check again. The form remounts after each save (keyed by
 * updatedAt) so it always shows what was stored.
 */
export function KitEditor({ kitId, body, updatedAt, locked }: { kitId: string; body: LaunchKitBody; updatedAt: string; locked: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function save(next: LaunchKitBody): Promise<boolean> {
    setNote(null);
    const out = await postJson<{ status: string; issues: { severity: string }[] }>(`/api/launch/kits/${kitId}/body`, { body: next });
    if (!out.ok) {
      setNote({ tone: "err", text: out.error });
      return false;
    }
    const blocks = out.data.issues.filter((i) => i.severity === "block").length;
    setNote({ tone: "ok", text: blocks ? `Saved. ${blocks} thing${blocks === 1 ? "" : "s"} still to fix before you can download it.` : "Saved. Every blocking check passed." });
    router.refresh();
    return true;
  }

  return (
    <div className="flex flex-col gap-3">
      <EditorForm key={updatedAt} body={body} locked={locked} onSave={save} />
      {note && <p className={`text-sm ${note.tone === "ok" ? "text-emerald-300" : "text-red-400"}`}>{note.text}</p>}
    </div>
  );
}

function EditorForm({ body, locked, onSave }: { body: LaunchKitBody; locked: boolean; onSave: (b: LaunchKitBody) => Promise<boolean> }) {
  const [draft, setDraft] = useState<LaunchKitBody>(body);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(body);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSave(draft);
        setBusy(false);
      }}
    >
      {draft.kind === "subreddit" && <SubredditForm body={draft} set={setDraft} disabled={locked} />}
      {draft.kind === "ambassador" && <AmbassadorForm body={draft} set={setDraft} disabled={locked} />}
      {draft.kind === "press" && <PressForm body={draft} set={setDraft} disabled={locked} />}
      {draft.kind === "creator" && <CreatorForm body={draft} set={setDraft} disabled={locked} />}
      {draft.kind === "reply_bank" && <ReplyBankForm body={draft} set={setDraft} disabled={locked} />}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-zinc-800 bg-zinc-950/95 py-3">
        <button type="submit" disabled={locked || busy || !dirty} className="rounded-lg bg-accent-strong px-3 py-1.5 text-sm font-medium text-zinc-50 disabled:opacity-50 hover:bg-accent-hover">
          {busy ? "Saving and checking…" : "Save changes"}
        </button>
        {dirty && !busy && (
          <button type="button" onClick={() => setDraft(body)} className="text-sm text-zinc-400 hover:text-zinc-200">
            Undo my changes
          </button>
        )}
        <span className="text-xs text-zinc-500">Saving runs every check again. Free.</span>
      </div>
    </form>
  );
}

// ── 1. subreddit ──

function SubredditForm({ body, set, disabled }: { body: SubredditKitBody; set: (b: LaunchKitBody) => void; disabled: boolean }) {
  return (
    <Section title="Drafts" hint={LINK_HINT}>
      <ItemList
        items={body.drafts}
        min={1}
        disabled={disabled}
        onChange={(drafts) => set({ ...body, drafts })}
        title={(d) => `r/${d.subreddit}`}
        render={(d, put) => (
          <>
            {d.proposed && (
              <p className="text-xs text-amber-300">{d.checkNote ?? "We suggested this community. Check it exists and allows posts like this before you use it."}</p>
            )}
            {d.likelyNotAllowed && <p className="text-xs text-amber-300">Their rules probably don&apos;t allow this kind of post. Read them before posting.</p>}
            <TextField
              label="Community (without r/)"
              value={d.subreddit}
              disabled={disabled}
              onChange={(v) => {
                const sub = subredditOf(v);
                put({ ...d, subreddit: sub, rulesUrl: sub ? redditRulesUrl(sub) : d.rulesUrl });
              }}
            />
            <TextField label="Title" value={d.title} max={REDDIT_TITLE_MAX} disabled={disabled} onChange={(v) => put({ ...d, title: v })} />
            <TextField label="Post" rows={8} value={d.body} disabled={disabled} onChange={(v) => put({ ...d, body: v })} />
            <TextField label="Best time to post" value={d.bestTime} disabled={disabled} onChange={(v) => put({ ...d, bestTime: v })} />
            {d.whyThisFits && <p className="text-xs text-zinc-500">Why this community: {d.whyThisFits}</p>}
          </>
        )}
      />
    </Section>
  );
}

// ── shared: disclosure + branded content ──

function DisclosureForm({ value, onChange, disabled }: { value: KitDisclosure; onChange: (d: KitDisclosure) => void; disabled: boolean }) {
  return (
    <Section title="Disclosure" hint="Required by the FTC for anyone who gets something for posting. The kit won't download without it.">
      <TextField
        label="First thing in every caption"
        value={value.captionPrefix}
        disabled={disabled}
        onChange={(v) => onChange({ ...value, captionPrefix: v })}
        hint="Keep #ad (or #sponsored) at the very start."
      />
      <TextField label="Said out loud at the start of videos" value={value.spokenLine} disabled={disabled} onChange={(v) => onChange({ ...value, spokenLine: v })} />
      <StringList label="The rules they follow" values={value.rules} disabled={disabled} onChange={(rules) => onChange({ ...value, rules })} />
    </Section>
  );
}

function TemplatesForm({ items, onChange, disabled }: { items: KitMessageTemplate[]; onChange: (t: KitMessageTemplate[]) => void; disabled: boolean }) {
  return (
    <ItemList
      items={items}
      min={1}
      disabled={disabled}
      onChange={onChange}
      addLabel="Add a message"
      make={(): KitMessageTemplate => ({ channel: "dm", subject: null, text: "" })}
      title={(t, i) => `Message ${i + 1} · ${t.channel === "email" ? "email" : "DM"}`}
      render={(t, put) => (
        <>
          <select
            aria-label="Sent as"
            value={t.channel}
            disabled={disabled}
            onChange={(e) => put({ ...t, channel: e.target.value as KitMessageTemplate["channel"], subject: e.target.value === "email" ? (t.subject ?? "") : null })}
            className={`${selectCls} self-start`}
          >
            <option value="dm">DM</option>
            <option value="email">Email</option>
          </select>
          {t.channel === "email" && <TextField label="Subject" value={t.subject ?? ""} disabled={disabled} onChange={(v) => put({ ...t, subject: v })} />}
          <TextField label="Message" rows={5} value={t.text} disabled={disabled} onChange={(v) => put({ ...t, text: v })} />
        </>
      )}
    />
  );
}

// ── 2. ambassador ──

function AmbassadorForm({ body, set, disabled }: { body: AmbassadorKitBody; set: (b: LaunchKitBody) => void; disabled: boolean }) {
  return (
    <>
      <Section title="The pitch" hint={LINK_HINT}>
        <TextField label="What you tell a possible ambassador" rows={4} value={body.pitch} disabled={disabled} onChange={(pitch) => set({ ...body, pitch })} />
        <StringList label="What they get" values={body.perks} disabled={disabled} onChange={(perks) => set({ ...body, perks })} />
      </Section>
      <Section title="Messages you send" hint="You send every one yourself. The app never sends messages.">
        <TemplatesForm items={body.templates} disabled={disabled} onChange={(templates) => set({ ...body, templates })} />
      </Section>
      <Section title="How to post">
        <StringList label="Posting guide" values={body.postingGuide} disabled={disabled} onChange={(postingGuide) => set({ ...body, postingGuide })} />
        <StringList label="Caption examples" rows={2} values={body.captionExamples} disabled={disabled} onChange={(captionExamples) => set({ ...body, captionExamples })} />
      </Section>
      <DisclosureForm value={body.disclosure} disabled={disabled} onChange={(disclosure) => set({ ...body, disclosure })} />
      <Section title="TikTok branded content steps">
        <StringList label="Steps" values={body.brandedContentSteps} disabled={disabled} onChange={(brandedContentSteps) => set({ ...body, brandedContentSteps })} />
      </Section>
      {body.links.length > 0 && (
        <Section title="Personal links" hint="Each ambassador's link counts their signups. Change the list by writing the kit again with new names.">
          <ul className="flex flex-col gap-2 text-sm">
            {body.links.map((l) => (
              <li key={l.ref} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {l.name} <span className="break-all text-zinc-500">{l.url}</span>
                </span>
                <CopyButton text={l.url} label="Copy link" />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ── 3. press ──

function PressForm({ body, set, disabled }: { body: PressKitBody; set: (b: LaunchKitBody) => void; disabled: boolean }) {
  return (
    <>
      <Section title="Fact sheet" hint="Rows from your profile, or facts you marked as fine to say in public.">
        <ItemList
          items={body.facts}
          min={1}
          disabled={disabled}
          onChange={(facts) => set({ ...body, facts })}
          title={(f) => f.label || "Fact"}
          render={(f, put) => (
            <>
              <TextField label="Label" value={f.label} disabled={disabled} onChange={(label) => put({ ...f, label })} />
              <TextField label="Value" value={f.value} disabled={disabled} onChange={(value) => put({ ...f, value })} />
            </>
          )}
        />
        <TextField label="About the product (a short paragraph)" rows={4} value={body.boilerplate} disabled={disabled} onChange={(boilerplate) => set({ ...body, boilerplate })} />
      </Section>
      <Section title="Your quote" hint={body.founderQuote.note}>
        <TextField
          label="Quote"
          rows={3}
          value={body.founderQuote.text}
          disabled={disabled}
          onChange={(text) => set({ ...body, founderQuote: { ...body.founderQuote, text } })}
        />
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={!body.founderQuote.editMe}
            disabled={disabled}
            onChange={(e) => set({ ...body, founderQuote: { ...body.founderQuote, editMe: !e.target.checked } })}
          />
          These are my words
        </label>
      </Section>
      {body.assets.length > 0 && (
        <Section title="Screenshots in the zip">
          <ItemList
            items={body.assets}
            disabled={disabled}
            onChange={(assets) => set({ ...body, assets })}
            title={(a) => a.label || "Screenshot"}
            render={(a, put) => (
              <div className="flex items-start gap-3">
                <img src={`/api/media/${a.assetId}?v=preview`} alt={a.label} className="h-16 w-16 rounded border border-zinc-800 object-cover" />
                <div className="flex-1">
                  <TextField label="Label" value={a.label} disabled={disabled} onChange={(label) => put({ ...a, label })} />
                </div>
              </div>
            )}
          />
        </Section>
      )}
      <Section title="Pitches" hint="Short emails you send yourself to student newsletters, papers and podcasts.">
        <ItemList
          items={body.pitches}
          min={1}
          disabled={disabled}
          onChange={(pitches) => set({ ...body, pitches })}
          addLabel="Add a pitch"
          make={(): PressKitBody["pitches"][number] => ({ outletType: "student_newsletter", outlet: "[Outlet]", subject: "", body: "", claimRefs: [] })}
          title={(p, i) => `${i + 1}. ${p.outlet}`}
          render={(p, put) => (
            <>
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                <select
                  aria-label="Kind"
                  value={p.outletType}
                  disabled={disabled}
                  onChange={(e) => put({ ...p, outletType: e.target.value as typeof p.outletType })}
                  className={selectCls}
                >
                  {PRESS_OUTLET_TYPES.map((k) => (
                    <option key={k} value={k}>
                      {OUTLET_LABEL[k]}
                    </option>
                  ))}
                </select>
                <TextField label="Where it goes" value={p.outlet} disabled={disabled} onChange={(outlet) => put({ ...p, outlet })} />
              </div>
              <TextField label="Subject" value={p.subject} disabled={disabled} onChange={(subject) => put({ ...p, subject })} />
              <TextField label="Email" rows={6} value={p.body} disabled={disabled} onChange={(v) => put({ ...p, body: v })} />
            </>
          )}
        />
      </Section>
    </>
  );
}

// ── 4. creator ──

function CreatorForm({ body, set, disabled }: { body: CreatorKitBody; set: (b: LaunchKitBody) => void; disabled: boolean }) {
  return (
    <>
      <Section title="The brief" hint={LINK_HINT}>
        <TextField label="What it is" rows={3} value={body.whatItIs} disabled={disabled} onChange={(whatItIs) => set({ ...body, whatItIs })} />
        <StringList label="What to show" values={body.whatToShow} disabled={disabled} onChange={(whatToShow) => set({ ...body, whatToShow })} />
        <StringList label="Do" values={body.dos} disabled={disabled} onChange={(dos) => set({ ...body, dos })} />
        <StringList label="Don't" values={body.donts} disabled={disabled} onChange={(donts) => set({ ...body, donts })} />
      </Section>
      <DisclosureForm value={body.disclosure} disabled={disabled} onChange={(disclosure) => set({ ...body, disclosure })} />
      <Section title="TikTok branded content steps">
        <StringList label="Steps" values={body.brandedContentSteps} disabled={disabled} onChange={(brandedContentSteps) => set({ ...body, brandedContentSteps })} />
      </Section>
      <Section title="Messages you send" hint="You send every one yourself. The app never sends messages.">
        <ItemList
          items={body.dmTemplates}
          min={1}
          disabled={disabled}
          onChange={(dmTemplates) => set({ ...body, dmTemplates })}
          addLabel="Add a message"
          make={() => ({ text: "" })}
          title={(_, i) => `Message ${i + 1}`}
          render={(t, put) => (
            <>
              <TextField label="Message" rows={5} value={t.text} disabled={disabled} onChange={(text) => put({ text })} />
            </>
          )}
        />
      </Section>
    </>
  );
}

// ── 5. reply bank ──

function ReplyBankForm({ body, set, disabled }: { body: ReplyBankBody; set: (b: LaunchKitBody) => void; disabled: boolean }) {
  return (
    <Section title="Edit the replies" hint={LINK_HINT}>
      <ItemList
        items={body.replies}
        min={1}
        disabled={disabled}
        onChange={(replies) => set({ ...body, replies })}
        addLabel="Add a reply"
        make={() => ({ trigger: "", reply: "", claimRefs: [] })}
        title={(r, i) => r.trigger || `Reply ${i + 1}`}
        render={(r, put) => (
          <>
            <TextField label="When someone asks" value={r.trigger} disabled={disabled} onChange={(trigger) => put({ ...r, trigger })} />
            <TextField label="Reply" rows={3} max={REPLY_MAX} value={r.reply} disabled={disabled} onChange={(reply) => put({ ...r, reply })} />
          </>
        )}
      />
    </Section>
  );
}
