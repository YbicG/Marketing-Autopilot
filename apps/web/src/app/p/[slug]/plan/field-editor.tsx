"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

type Mode = "line" | "text" | "lines" | "json";

function modeFor(value: unknown): Mode {
  if (value === null || value === undefined || typeof value === "string") {
    return typeof value === "string" && value.length > 80 ? "text" : "line";
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return "lines";
  return "json";
}

function toText(value: unknown, mode: Mode): string {
  if (mode === "line" || mode === "text") return typeof value === "string" ? value : "";
  if (mode === "lines") return (value as string[]).join("\n");
  return JSON.stringify(value, null, 2);
}

function fromText(text: string, mode: Mode): { ok: true; value: unknown } | { ok: false; error: string } {
  if (mode === "line" || mode === "text") return { ok: true, value: text.trim() };
  if (mode === "lines") return { ok: true, value: text.split("\n").map((l) => l.trim()).filter(Boolean) };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "That isn't valid. Keep the same brackets and quotes, and change only the words." };
  }
}

type Props = {
  slug: string;
  dnaVersionId: string;
  path: string;
  label: string;
  value: unknown;
  onDone?: () => void;
  autoFocus?: boolean;
};

/** Inline fix for one profile field. Saving makes it yours and keeps it on the next rewrite. */
export function FieldEditor({ slug, dnaVersionId, path, label, value, onDone, autoFocus }: Props) {
  const router = useRouter();
  const mode = modeFor(value);
  const [text, setText] = useState(() => toText(value, mode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `edit-${path.replace(/\W/g, "-")}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = fromText(text, mode);
    if (!parsed.ok) return setError(parsed.error);
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/products/${encodeURIComponent(slug)}/dna`, {
      action: "edit",
      dnaVersionId,
      path,
      value: parsed.value,
    });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    onDone?.();
    router.refresh();
  }

  const box = "w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-600";
  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      {mode === "line" ? (
        <input id={id} value={text} onChange={(e) => setText(e.target.value)} autoFocus={autoFocus} className={box} />
      ) : (
        <textarea
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus={autoFocus}
          rows={mode === "json" ? 8 : 4}
          spellCheck={mode !== "json"}
          className={`${box} ${mode === "json" ? "font-mono text-xs" : ""}`}
        />
      )}
      {mode === "lines" && <p className="text-xs text-zinc-500">One per line.</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-600">
            Cancel
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
