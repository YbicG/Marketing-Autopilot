"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { FolderDrop } from "@/components/intake/FolderDrop";
import { buildFolderFormData, type FolderSelection } from "@/components/intake/folder-drop";
import { LINK_LABEL, MAX_LINKS, splitLinks } from "@/lib/link-chips";
import { postJson } from "@/lib/post-json";

const field =
  "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm outline-none focus:border-zinc-600";

/** "What are we marketing?" (§2.3): links, a project folder and notes, then one button. */
export function DropZone() {
  const router = useRouter();
  const [linksText, setLinksText] = useState("");
  const [notes, setNotes] = useState("");
  const [folder, setFolder] = useState<FolderSelection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chips = useMemo(() => splitLinks(linksText), [linksText]);
  const links = chips.filter((c) => c.kind !== "unknown").map((c) => c.raw);
  const tooMany = links.length > MAX_LINKS;
  const hasInput = links.length > 0 || !!folder || notes.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasInput || tooMany || busy) return;
    setError(null);

    let folderUploadId: string | null = null;
    if (folder) {
      setBusy("Uploading files…");
      try {
        const res = await fetch("/api/uploads/folder", { method: "POST", body: buildFolderFormData(folder) });
        const body = (await res.json().catch(() => ({}))) as { folderUploadId?: string; error?: string };
        if (!res.ok || !body.folderUploadId) {
          setError(body.error ?? "The upload didn't go through. Try again.");
          setBusy(null);
          return;
        }
        folderUploadId = body.folderUploadId;
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
        setBusy(null);
        return;
      }
    }

    setBusy("Starting…");
    const out = await postJson<{ runId?: string }>("/api/runs", {
      kind: "ingest",
      links,
      notes: notes.trim() || null,
      folderUploadId,
    });
    if (!out.ok || !out.data.runId) {
      setError(out.ok ? "Couldn't start. Try again." : out.error);
      setBusy(null);
      return;
    }
    router.push(`/runs/${out.data.runId}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="links" className="text-sm text-zinc-400">
          Links (your website, GitHub repo)
        </label>
        <textarea
          id="links"
          rows={2}
          value={linksText}
          onChange={(e) => setLinksText(e.target.value)}
          placeholder="syllacal.com  github.com/you/your-app"
          className={`${field} resize-y`}
        />
        {(chips.length > 0 || folder || notes.trim()) && (
          <ul className="flex flex-wrap gap-2 text-xs" aria-label="What we'll read">
            {chips.map((c) => (
              <li
                key={c.raw}
                className={`rounded-full border px-2.5 py-1 ${
                  c.kind === "unknown" ? "border-amber-800 text-amber-300" : "border-zinc-700 text-zinc-300"
                }`}
              >
                <span className="font-medium">{LINK_LABEL[c.kind]}</span> <span className="text-zinc-500">{c.raw}</span>
              </li>
            ))}
            {folder && (
              <li className="rounded-full border border-zinc-700 px-2.5 py-1 text-zinc-300">
                <span className="font-medium">Project folder</span> <span className="text-zinc-500">{folder.rootName}</span>
              </li>
            )}
            {notes.trim() && <li className="rounded-full border border-zinc-700 px-2.5 py-1 font-medium text-zinc-300">Notes</li>}
          </ul>
        )}
        {chips.some((c) => c.kind === "unknown") && (
          <p className="text-xs text-amber-300">Words that aren't links are left out. Put them in the notes instead.</p>
        )}
        {tooMany && <p className="text-xs text-red-400">Up to {MAX_LINKS} links, please.</p>}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-zinc-400">
          Got the code? Drop the project folder. We only read the README, docs, package.json and screenshots.
        </p>
        <FolderDrop onReady={setFolder} />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="notes" className="text-sm text-zinc-400">
          Notes (optional, kept private)
        </label>
        <textarea
          id="notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={20_000}
          placeholder="Anything we should know: who buys it, what's coming, what you've tried"
          className={`${field} resize-y`}
        />
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={!!busy || !hasInput || tooMany}
          className="shrink-0 rounded-md bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
        >
          {busy ?? "Read my product"}
        </button>
        <p className="text-xs text-zinc-500">~$0.80 · ~4 min · you can close this tab</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
