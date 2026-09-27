"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { postJson } from "@/lib/post-json";

export interface SenderSettingsValue {
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  postalAddress?: string;
  audienceId?: string;
  audienceLabel?: string;
  consentSource?: string;
  euConsentAck?: boolean;
}

type Audience = { id: string; name: string };
type Count = { subscribed: number; unsubscribed: number; more: boolean };

const input = "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600 disabled:opacity-60";
const labelCls = "flex flex-col gap-1 text-sm";

function countLine(c: Count): string {
  const n = c.subscribed.toLocaleString("en-US");
  const people = c.more ? `${n}+ people` : `${n} ${c.subscribed === 1 ? "person" : "people"}`;
  return c.unsubscribed ? `${people} (${c.unsubscribed.toLocaleString("en-US")} more have unsubscribed and are skipped)` : people;
}

/**
 * Who the seasonal email is from, the footer the law needs (postal address, why you get this) and
 * which Resend list it goes to (§8 email law row). Saved per product.
 */
export function SenderSettings({
  slug,
  initial,
  missing,
  hasResendKey,
}: {
  slug: string;
  initial: SenderSettingsValue | null;
  missing: string[];
  hasResendKey: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState<SenderSettingsValue>(initial ?? {});
  const [audiences, setAudiences] = useState<Audience[] | null>(null);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [count, setCount] = useState<Count | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<SenderSettingsValue>) => {
    setSaved(false);
    setV((x) => ({ ...x, ...patch }));
  };
  const q = `slug=${encodeURIComponent(slug)}`;

  const loadLists = useCallback(async () => {
    setLoadingLists(true);
    setListError(null);
    try {
      const res = await fetch(`/api/email/audiences?${q}`);
      const data = (await res.json().catch(() => ({}))) as { audiences?: Audience[]; error?: string };
      if (!res.ok) setListError(data.error ?? "Couldn't load your Resend lists. Try again.");
      else setAudiences(data.audiences ?? []);
    } catch {
      setListError("Couldn't reach the server. Check your connection and try again.");
    }
    setLoadingLists(false);
  }, [q]);

  const loadCount = useCallback(
    async (id: string) => {
      setCount(null);
      setCountError(null);
      try {
        const res = await fetch(`/api/email/audiences?${q}&count=${encodeURIComponent(id)}`);
        const data = (await res.json().catch(() => ({}))) as { count?: Count; error?: string };
        if (!res.ok || !data.count) setCountError(data.error ?? "Couldn't count the contacts.");
        else setCount(data.count);
      } catch {
        setCountError("Couldn't count the contacts.");
      }
    },
    [q],
  );

  useEffect(() => {
    if (!hasResendKey) return;
    void loadLists();
    if (initial?.audienceId) void loadCount(initial.audienceId);
  }, [hasResendKey, loadLists, loadCount, initial?.audienceId]);

  function pick(id: string) {
    const a = audiences?.find((x) => x.id === id);
    set({ audienceId: id || undefined, audienceLabel: a?.name });
    if (id) void loadCount(id);
    else setCount(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const out = await postJson("/api/email/settings", { slug, settings: v });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setSaved(true);
    router.refresh();
  }

  const listOptions = audiences ?? (v.audienceId ? [{ id: v.audienceId, name: v.audienceLabel ?? v.audienceId }] : []);
  const knownPick = !v.audienceId || listOptions.some((a) => a.id === v.audienceId);

  return (
    <form onSubmit={save} className="flex flex-col gap-4 rounded-md border border-zinc-800 p-4" aria-label="Sender settings">
      <div>
        <h2 className="font-semibold">Who it&apos;s from and who gets it</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Every email carries these in its footer, with a one-click unsubscribe link Resend fills in. Changing them sends any approved or scheduled
          email back for your approval.
        </p>
      </div>

      {missing.length > 0 && (
        <div className="rounded-md border border-amber-900/70 bg-amber-950/20 px-3 py-2 text-sm text-amber-200">
          <p>Before an email can be approved, add:</p>
          <ul className="mt-1 list-disc pl-5">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          <span>From name</span>
          <input value={v.fromName ?? ""} onChange={(e) => set({ fromName: e.target.value })} placeholder="CJ at SyllaCal" maxLength={80} className={input} />
        </label>
        <label className={labelCls}>
          <span>From address</span>
          <input
            type="email"
            value={v.fromEmail ?? ""}
            onChange={(e) => set({ fromEmail: e.target.value })}
            placeholder="cj@yourdomain.com"
            className={input}
            aria-describedby="from-help"
          />
          <span id="from-help" className="text-xs text-zinc-500">
            Must be on a domain you verified in Resend.
          </span>
        </label>
        <label className={labelCls}>
          <span>
            Reply-to <span className="text-zinc-500">(optional)</span>
          </span>
          <input type="email" value={v.replyTo ?? ""} onChange={(e) => set({ replyTo: e.target.value })} placeholder="Where replies should go" className={input} />
        </label>
        <label className={labelCls}>
          <span>Postal address</span>
          <input
            value={v.postalAddress ?? ""}
            onChange={(e) => set({ postalAddress: e.target.value })}
            placeholder="PO Box 123, Austin, TX 78701"
            maxLength={300}
            className={input}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm">Which Resend list it goes to</span>
        {!hasResendKey ? (
          <p className="text-sm text-zinc-400">
            Add your Resend API key in{" "}
            <Link href="/settings/keys" className="underline underline-offset-2 hover:text-zinc-200">
              Settings → Keys
            </Link>{" "}
            to pick a list.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={v.audienceId ?? ""}
              onChange={(e) => pick(e.target.value)}
              disabled={loadingLists && !audiences}
              aria-label="Resend list"
              className={`${input} sm:w-auto sm:min-w-64`}
            >
              <option value="">{loadingLists && !audiences ? "Loading your lists…" : "Pick a list"}</option>
              {listOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadLists()}
              disabled={loadingLists}
              className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
            >
              {loadingLists ? "Loading…" : "Reload lists"}
            </button>
          </div>
        )}
        {listError && <p className="text-sm text-red-400">{listError}</p>}
        {audiences && audiences.length === 0 && <p className="text-sm text-zinc-400">Your Resend account has no lists yet. Make one in Resend with your past buyers, then reload.</p>}
        {!knownPick && audiences && <p className="text-sm text-amber-300">The saved list isn&apos;t in your Resend account any more. Pick another.</p>}
        {count && <p className="text-xs text-zinc-400">{countLine(count)}</p>}
        {countError && <p className="text-xs text-zinc-500">{countError}</p>}
      </div>

      <label className={labelCls}>
        <span>Where these contacts came from</span>
        <input
          value={v.consentSource ?? ""}
          onChange={(e) => set({ consentSource: e.target.value })}
          placeholder="You bought SyllaCal and said yes to product news"
          maxLength={300}
          className={input}
        />
        <span className="text-xs text-zinc-500">Shown in the footer as the reason they get this email. Only send to people who bought or signed up.</span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={v.euConsentAck === true} onChange={(e) => set({ euConsentAck: e.target.checked })} className="mt-1" />
        <span>Everyone on this list in the EU or UK agreed to hear from me by email. (If you&apos;re not sure, leave them off the list.)</span>
      </label>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? "Saving…" : "Save sender settings"}
        </button>
        {saved && !error && <span className="text-xs text-emerald-400">Saved.</span>}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
