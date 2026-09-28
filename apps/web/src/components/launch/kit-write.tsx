"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { KitKind } from "@mkt/contracts";
import { postJson } from "@/lib/post-json";
import { KitInputFields } from "./kit-inputs";
import { inputsFor, KIND_BLURB, TAKES_INPUT, writeAllKinds, type InputDraft, type KitStatusKey } from "./kit-model";
import { KitCostChip, KitStatusChip } from "./kit-status";

export interface KitOverviewCard {
  kind: KitKind;
  label: string;
  status: KitStatusKey;
  href: string;
  priceLabel: string;
  blocks: number;
  warns: number;
  needsYouReason: string | null;
  exportBlockedReason: string | null;
  summary: string | null;
}

function useKitWrite(launchPlanId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function write(kinds: KitKind[], draft: InputDraft): Promise<boolean> {
    if (busy) return false;
    const parsed = inputsFor(kinds, draft);
    if (parsed.error !== null) {
      setError(parsed.error);
      return false;
    }
    setBusy(true);
    setError(null);
    const out = await postJson("/api/launch/kits", { launchPlanId, kinds, inputs: parsed.inputs });
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return false;
    }
    router.refresh();
    return true;
  }
  return { busy, error, write };
}

const primary = "min-h-11 md:min-h-9 rounded-lg bg-accent-strong px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-accent-hover disabled:opacity-50";
const secondary = "inline-flex min-h-11 md:min-h-9 items-center rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50";

/** The overview (§5.4 LC launch kit): one card per part, "Write it" per card and "Write all" for the rest. */
export function KitOverview({
  launchPlanId,
  cards,
  initialDraft,
  allPriceLabel,
}: {
  launchPlanId: string;
  cards: KitOverviewCard[];
  initialDraft: InputDraft;
  allPriceLabel: string | null;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const { busy, error, write } = useKitWrite(launchPlanId);
  const pending = writeAllKinds(cards);
  const writing = cards.some((c) => c.status === "generating" || c.status === "planned");

  return (
    <div className="flex flex-col gap-4">
      {pending.length > 1 && allPriceLabel && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-sm text-zinc-300">
            {pending.length} parts aren&apos;t written yet. What you type in each card below is used.
          </p>
          <button type="button" disabled={busy} onClick={() => void write(pending, draft)} className={primary}>
            {busy ? "Starting…" : `Write all · ~${allPriceLabel}`}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {cards.map((c) => {
          const canWrite = c.status === "missing" || c.status === "failed";
          const inProgress = c.status === "generating" || c.status === "planned";
          return (
            <article key={c.kind} className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{c.label}</h2>
                <span className="flex items-center gap-2">
                  <KitCostChip label={c.priceLabel} />
                  <KitStatusChip status={c.status} />
                </span>
              </header>
              <p className="text-sm text-zinc-400">{KIND_BLURB[c.kind]}</p>
              {c.summary && <p className="text-sm text-zinc-300">{c.summary}</p>}
              {c.needsYouReason && <p className="text-sm text-amber-300">{c.needsYouReason}</p>}
              {(c.blocks > 0 || c.warns > 0) && (
                <p className="text-xs text-zinc-400">
                  {c.blocks > 0 && <span className="text-red-300">{c.blocks} to fix first</span>}
                  {c.blocks > 0 && c.warns > 0 && " · "}
                  {c.warns > 0 && <span className="text-amber-300">{c.warns} worth a look</span>}
                </p>
              )}
              {canWrite && TAKES_INPUT.has(c.kind) && (
                <details className="rounded-md border border-zinc-800 p-3">
                  <summary className="flex min-h-11 cursor-pointer items-center text-sm text-zinc-300 md:min-h-0">Tell us more (optional)</summary>
                  <div className="mt-3">
                    <KitInputFields kind={c.kind} draft={draft} onChange={setDraft} />
                  </div>
                </details>
              )}
              <div className="mt-auto flex flex-wrap items-center gap-2">
                {canWrite && (
                  <button type="button" disabled={busy || inProgress} onClick={() => void write([c.kind], draft)} className={primary}>
                    {c.status === "failed" ? `Try again · ~${c.priceLabel}` : `Write it · ~${c.priceLabel}`}
                  </button>
                )}
                {c.status !== "missing" && (
                  <Link href={c.href} className={secondary}>
                    {inProgress ? "Watch it" : "Open"}
                    <span className="sr-only"> {c.label}</span>
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {writing && <p className="text-xs text-zinc-500">You can leave this page. The kit keeps being written on your server.</p>}
    </div>
  );
}

/** "Write it again · ~$x" on a kit's page. Replacing a kit loses edits, so it asks once. */
export function KitWriteAgain({
  launchPlanId,
  kind,
  priceLabel,
  initialDraft,
  disabled,
  firstTime,
}: {
  launchPlanId: string;
  kind: KitKind;
  priceLabel: string;
  initialDraft: InputDraft;
  disabled: boolean;
  firstTime: boolean;
}) {
  const [open, setOpen] = useState(firstTime);
  const [draft, setDraft] = useState(initialDraft);
  const { busy, error, write } = useKitWrite(launchPlanId);
  const label = firstTime ? `Write it · ~${priceLabel}` : `Write it again · ~${priceLabel}`;

  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={secondary}>
        {label}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      {TAKES_INPUT.has(kind) && <KitInputFields kind={kind} draft={draft} onChange={setDraft} />}
      {!firstTime && <p className="text-sm text-amber-300">This replaces what&apos;s here, including your edits.</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || disabled}
          onClick={async () => {
            if (await write([kind], draft)) setOpen(firstTime);
          }}
          className={primary}
        >
          {busy ? "Starting…" : label}
        </button>
        {!firstTime && (
          <button type="button" onClick={() => setOpen(false)} className={secondary}>
            Keep this one
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
