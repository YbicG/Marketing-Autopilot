"use client";
import type { ReactNode } from "react";

// Form pieces for the kit editors. Every field edits a plain value; the editors put them back into
// the contract body so a save round-trips the kind's schema.

const inputCls = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm disabled:opacity-60";
const small = "text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-40";

export function TextField({
  label,
  value,
  onChange,
  rows,
  hint,
  max,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
  max?: number;
  disabled?: boolean;
}) {
  const over = max !== undefined && value.length > max;
  return (
    <label className="flex flex-col gap-1 text-sm text-zinc-300">
      <span className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        {max !== undefined && <span className={`text-xs ${over ? "text-red-400" : "text-zinc-500"}`}>{`${value.length}/${max}`}</span>}
      </span>
      {rows && rows > 1 ? (
        <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={inputCls} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={inputCls} />
      )}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

/** A list of short texts (perks, steps, rules…). */
export function StringList({
  label,
  values,
  onChange,
  rows = 1,
  addLabel = "Add one",
  min = 0,
  disabled,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  rows?: number;
  addLabel?: string;
  min?: number;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2 text-sm">
      <legend className="mb-1 text-zinc-300">{label}</legend>
      {values.map((v, i) => (
        <div key={i} className="flex items-start gap-2">
          {rows > 1 ? (
            <textarea
              rows={rows}
              aria-label={`${label} ${i + 1}`}
              value={v}
              disabled={disabled}
              onChange={(e) => onChange(values.map((x, n) => (n === i ? e.target.value : x)))}
              className={inputCls}
            />
          ) : (
            <input
              aria-label={`${label} ${i + 1}`}
              value={v}
              disabled={disabled}
              onChange={(e) => onChange(values.map((x, n) => (n === i ? e.target.value : x)))}
              className={inputCls}
            />
          )}
          <button type="button" disabled={disabled || values.length <= min} onClick={() => onChange(values.filter((_, n) => n !== i))} className={`${small} pt-2`}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...values, ""])} className={`${small} self-start underline underline-offset-2`}>
        {addLabel}
      </button>
    </fieldset>
  );
}

/** A list of structured items (drafts, pitches, replies…), each rendered by the caller. */
export function ItemList<T>({
  items,
  onChange,
  render,
  make,
  title,
  addLabel,
  min = 0,
  disabled,
}: {
  items: T[];
  onChange: (v: T[]) => void;
  render: (item: T, set: (next: T) => void, index: number) => ReactNode;
  make?: () => T;
  title: (item: T, index: number) => string;
  addLabel?: string;
  min?: number;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border border-zinc-800 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-zinc-200">{title(item, i)}</p>
            <button type="button" disabled={disabled || items.length <= min} onClick={() => onChange(items.filter((_, n) => n !== i))} className={small}>
              Remove
            </button>
          </div>
          {render(item, (next) => onChange(items.map((x, n) => (n === i ? next : x))), i)}
        </div>
      ))}
      {make && addLabel && (
        <button type="button" disabled={disabled} onClick={() => onChange([...items, make()])} className={`${small} self-start underline underline-offset-2`}>
          {addLabel}
        </button>
      )}
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div>
        <h3 className="font-medium">{title}</h3>
        {hint && <p className="text-xs text-zinc-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
