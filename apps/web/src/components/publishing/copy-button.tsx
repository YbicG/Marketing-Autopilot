"use client";
import { useState } from "react";

/** Copies `text` to the clipboard and says so. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState<"ok" | "fail" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone("ok");
    } catch {
      setDone("fail");
    }
    setTimeout(() => setDone(null), 2000);
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      disabled={!text}
      className={className ?? "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50"}
    >
      {done === "ok" ? "Copied" : done === "fail" ? "Couldn't copy. Select the text instead." : label}
    </button>
  );
}
