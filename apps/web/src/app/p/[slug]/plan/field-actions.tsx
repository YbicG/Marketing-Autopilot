"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";
import { FieldEditor } from "./field-editor";

type Props = { slug: string; dnaVersionId: string; path: string; label: string; value: unknown; pinned: boolean };

/** "Wrong?" and the pin toggle for one profile field. */
export function FieldActions({ slug, dnaVersionId, path, label, value, pinned }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function togglePin() {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/products/${encodeURIComponent(slug)}/dna`, { action: "pin", dnaVersionId, path, pinned: !pinned });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3 text-xs">
        <button type="button" onClick={() => setEditing((v) => !v)} className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
          Wrong?
        </button>
        <button
          type="button"
          onClick={() => void togglePin()}
          disabled={busy}
          aria-pressed={pinned}
          title={pinned ? "Kept as is when the profile is rewritten" : "Keep this as is when the profile is rewritten"}
          className={`underline-offset-2 hover:underline disabled:opacity-60 ${pinned ? "text-amber-300" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          {pinned ? "Pinned" : "Pin"}
        </button>
      </div>
      {editing && (
        <FieldEditor slug={slug} dnaVersionId={dnaVersionId} path={path} label={label} value={value} onDone={() => setEditing(false)} autoFocus />
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
