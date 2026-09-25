"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export interface UploadedMedia {
  assetId: string;
  kind: "image" | "recording";
  created: boolean;
  durationMs: number | null;
  hasPersonalData: boolean;
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm";
const MAX_MB = 300;

/** POSTs one file to /api/uploads/media with upload progress (recordings can be big). */
function send(slug: string, file: File, onProgress: (pct: number) => void): Promise<{ ok: true; data: UploadedMedia } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("slug", slug);
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads/media");
    xhr.setRequestHeader("x-mkt-csrf", "1");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: (Partial<UploadedMedia> & { error?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText) as Partial<UploadedMedia> & { error?: string };
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.assetId) resolve({ ok: true, data: body as UploadedMedia });
      else resolve({ ok: false, error: body?.error ?? (xhr.status === 413 ? `That file is over ${MAX_MB} MB. Trim it and try again.` : "That upload didn't work. Try again.") });
    };
    xhr.onerror = () => resolve({ ok: false, error: "Couldn't reach the server. Check your connection and try again." });
    xhr.send(form);
  });
}

/**
 * Upload a screenshot or screen recording for this project. The server checks the file itself; a
 * recording it can't read is refused with what to do.
 */
export function MediaUploader({ slug, onUploaded, compact = false }: { slug: string; onUploaded?: (m: UploadedMedia) => void; compact?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function upload(files: FileList | null) {
    const list = files ? [...files] : [];
    if (!list.length) return;
    setMsg(null);
    let done = 0;
    for (const file of list) {
      if (file.size > MAX_MB * 1024 * 1024) {
        setMsg({ tone: "err", text: `${file.name} is over ${MAX_MB} MB. Trim it or export at 1080p, then try again.` });
        continue;
      }
      setProgress(0);
      const out = await send(slug, file, setProgress);
      setProgress(null);
      if (!out.ok) {
        setMsg({ tone: "err", text: `${file.name}: ${out.error}` });
        continue;
      }
      done++;
      onUploaded?.(out.data);
      if (out.data.hasPersonalData) setMsg({ tone: "err", text: `${file.name} shows personal details, so it won't be used in videos.` });
      else setMsg({ tone: "ok", text: out.data.created ? `${file.name} added.` : `${file.name} was already here.` });
    }
    if (input.current) input.current.value = "";
    if (done) router.refresh();
  }

  return (
    <div className={`flex flex-col gap-2 ${compact ? "" : "rounded-md border border-dashed border-zinc-700 p-4"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={progress !== null}
          className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400 disabled:opacity-60"
        >
          {progress !== null ? `Uploading… ${progress}%` : "Upload a screenshot or recording"}
        </button>
        {!compact && <span className="text-xs text-zinc-500">PNG, JPEG, WebP or GIF up to 20 MB · MP4, MOV or WebM up to {MAX_MB} MB and 10 minutes</span>}
      </div>
      <input ref={input} type="file" accept={ACCEPT} multiple={!compact} className="hidden" onChange={(e) => void upload(e.target.files)} aria-label="Choose files to upload" />
      {msg && <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-400" : "text-amber-300"}`}>{msg.text}</p>}
    </div>
  );
}
