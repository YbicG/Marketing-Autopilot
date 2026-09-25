"use client";
import { useState } from "react";
import { MediaUploader } from "./media-uploader";

/** Serializable EditorFootage (core/video/editor.ts). */
export interface FootageItem {
  id: string;
  kind: string;
  origin: string;
  tier: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  caption: string | null;
}

export const secs = (ms: number | null | undefined) => (ms ? `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}` : "");

const ORIGIN_LABEL: Record<string, string> = {
  captured: "Recorded from your demo",
  uploaded: "Uploaded by you",
  generated: "Made with AI",
  licensed: "Licensed",
  template: "Template",
};

export function FootageThumb({ f, className = "" }: { f: FootageItem; className?: string }) {
  if (f.kind === "recording") {
    return (
      <span className={`flex items-center justify-center bg-zinc-900 text-xs text-zinc-400 ${className}`}>
        ▶ Recording {secs(f.durationMs)}
      </span>
    );
  }
  return <img src={`/api/media/${f.id}?v=preview`} alt={f.caption ?? "Screenshot"} className={`object-cover ${className}`} loading="lazy" />;
}

export function originLabel(origin: string): string {
  return ORIGIN_LABEL[origin] ?? origin;
}

/** Scene picture picker: this project's screenshots and recordings, plus an upload. */
export function AssetPicker({
  slug,
  footage,
  value,
  allowNone,
  onPick,
}: {
  slug: string;
  footage: FootageItem[];
  value: string | null;
  allowNone: boolean;
  onPick: (asset: FootageItem | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = footage.find((f) => f.id === value) ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {current ? (
          <FootageThumb f={current} className="h-16 w-24 rounded border border-zinc-800" />
        ) : (
          <span className="flex h-16 w-24 items-center justify-center rounded border border-dashed border-zinc-700 text-xs text-zinc-500">
            {value ? "Not available" : "Text only"}
          </span>
        )}
        <div className="flex flex-col gap-1 text-xs text-zinc-400">
          {current && <span>{current.caption ?? (current.kind === "recording" ? "Screen recording" : "Screenshot")}</span>}
          {value && !current && <span className="text-amber-300">This picture was removed or shows personal details. Pick another.</span>}
          <button type="button" onClick={() => setOpen((o) => !o)} className="self-start text-zinc-300 underline underline-offset-2">
            {open ? "Close" : "Change picture"}
          </button>
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-3 rounded-md border border-zinc-800 p-3">
          {footage.length ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {footage.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(f);
                      setOpen(false);
                    }}
                    className={`flex w-full flex-col gap-1 rounded border p-1 text-left text-[11px] ${f.id === value ? "border-zinc-200" : "border-zinc-800 hover:border-zinc-500"}`}
                    aria-label={`Use ${f.caption ?? f.kind}`}
                  >
                    <FootageThumb f={f} className="h-16 w-full rounded" />
                    <span className="truncate text-zinc-400">{f.caption ?? (f.kind === "recording" ? "Screen recording" : "Screenshot")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">No screenshots or recordings yet. Upload one, or record your demo on the Capture page.</p>
          )}
          {allowNone && (
            <button
              type="button"
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              className="self-start text-xs text-zinc-400 underline underline-offset-2"
            >
              Use text only
            </button>
          )}
          <MediaUploader slug={slug} compact />
        </div>
      )}
    </div>
  );
}
