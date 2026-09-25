"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";
import { FieldEditor } from "./field-editor";

export type UnsureItem = { path: string; label: string; question: string; value: unknown };

type Props = { slug: string; dnaVersionId: string; items: UnsureItem[]; confirmed: boolean };

/** Top of the plan: "N things we're unsure about", each with an inline fix, plus "These look right". */
export function UnsureList({ slug, dnaVersionId, items, confirmed }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/products/${encodeURIComponent(slug)}/dna`, { action: "confirm", dnaVersionId });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4 rounded-md border border-zinc-800 p-5" aria-label="Things to check">
      <h2 className="text-lg font-semibold">
        {items.length === 0
          ? "Nothing we're unsure about"
          : `${items.length} ${items.length === 1 ? "thing" : "things"} we're unsure about`}
      </h2>
      {items.length > 0 && (
        <ul className="flex flex-col gap-4">
          {items.map((it) => (
            <li key={it.path} className="flex flex-col gap-2">
              <p className="text-sm">
                <span className="text-zinc-500">{it.label}: </span>
                <span className="text-zinc-200">{it.question}</span>
              </p>
              <FieldEditor slug={slug} dnaVersionId={dnaVersionId} path={it.path} label={it.label} value={it.value} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        {confirmed ? (
          <p className="text-sm text-emerald-400">You confirmed this profile.</p>
        ) : (
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
          >
            {busy ? "Saving…" : "These look right"}
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
