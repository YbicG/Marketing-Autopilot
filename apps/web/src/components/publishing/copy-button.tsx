"use client";
import { useEffect, useRef, useState } from "react";

/** Copies `text` to the clipboard and says so. */
export function CopyButton({ text, label, className, disabled = false }: { text: string; label: string; className?: string; disabled?: boolean }) {
  const [done, setDone] = useState<"ok" | "fail" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone("ok");
    } catch {
      setDone("fail");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(null), 2000);
  }
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        disabled={disabled || !text}
        className={className ?? "inline-flex min-h-11 items-center rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50 md:min-h-9"}
      >
        {done === "ok" ? "Copied" : done === "fail" ? "Couldn't copy. Select the text instead." : label}
      </button>
      <span className="sr-only" aria-live="polite">
        {done === "ok" ? "Copied" : done === "fail" ? "Couldn't copy. Select the text instead." : ""}
      </span>
    </>
  );
}
