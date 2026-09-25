"use client";
import { useState } from "react";
import { FOLDER_LIMITS, planIntake, type IntakeKind } from "@mkt/contracts";
import {
  walkDroppedItems,
  walkInputFiles,
  type FolderSelection,
  type WalkResult,
  type WalkSkipped,
} from "./folder-drop";

type Props = { onReady(selection: FolderSelection | null): void };

type Manifest = {
  rootName: string;
  included: { path: string; kind: IntakeKind; size: number; file: File }[];
  skipped: WalkSkipped[];
  totalBytes: number;
};

const KIND_LABEL: Record<IntakeKind, string> = {
  readme: "README",
  doc: "Doc",
  package_json: "package.json",
  app_json: "App config",
  git_config: "Git remote",
  image: "Image",
};

const REASON_LABEL: Record<WalkSkipped["reason"], string> = {
  denied: "private or build folder",
  not_allowlisted: "not needed",
  too_large: "over 2 MB",
  over_total: "over the 10 MB total",
  credential_content: "looks like it holds keys",
};

const SKIPPED_RENDER_CAP = 300;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toManifest(walk: WalkResult): Manifest {
  const byPath = new Map(walk.files.map((f) => [f.path, f.file]));
  const plan = planIntake(walk.files.map((f) => ({ path: f.path, size: f.file.size })));
  return {
    rootName: walk.rootName,
    included: plan.included.flatMap((d) => {
      const file = byPath.get(d.path);
      return file ? [{ path: d.path, kind: d.kind, size: d.size, file }] : [];
    }),
    skipped: [...walk.skipped, ...plan.skipped],
    totalBytes: plan.totalBytes,
  };
}

export function FolderDrop({ onReady }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function load(walk: Promise<WalkResult>) {
    setBusy(true);
    setError(null);
    setConfirmed(false);
    try {
      setManifest(toManifest(await walk));
    } catch {
      setError("Couldn't read that folder. Try the Choose folder button instead.");
      setManifest(null);
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    // Must start synchronously inside the event: the item list is cleared once the handler returns.
    void load(walkDroppedItems(e.dataTransfer.items));
  }

  function onChoose(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) void load(walkInputFiles(Array.from(files)));
    e.target.value = "";
  }

  function clear() {
    setManifest(null);
    setConfirmed(false);
    setError(null);
    onReady(null);
  }

  function confirmFiles() {
    if (!manifest || manifest.included.length === 0) return;
    setConfirmed(true);
    onReady({
      rootName: manifest.rootName,
      files: manifest.included.map((f) => ({ path: f.path, kind: f.kind, file: f.file })),
    });
  }

  const pct = manifest ? Math.min(100, (manifest.totalBytes / FOLDER_LIMITS.maxTotalBytes) * 100) : 0;

  return (
    <div className="flex flex-col gap-3">
      {!manifest && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-10 text-center transition-colors ${
            dragging ? "border-zinc-400 bg-zinc-900" : "border-zinc-800 bg-zinc-950"
          }`}
        >
          <p className="text-sm font-medium text-zinc-100">
            {busy ? "Reading folder…" : "Drop your project folder"}
          </p>
          <p className="text-xs text-zinc-500">We only read the README, docs, package.json and screenshots.</p>
          <label className="mt-2 cursor-pointer rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600">
            Choose folder
            <input
              type="file"
              multiple
              className="hidden"
              disabled={busy}
              onChange={onChoose}
              ref={(el) => {
                if (el) {
                  el.setAttribute("webkitdirectory", "");
                  el.setAttribute("directory", "");
                }
              }}
            />
          </label>
        </div>
      )}

      {manifest && (
        <div className="flex flex-col gap-3 rounded-md border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-zinc-100">
              {manifest.included.length} {manifest.included.length === 1 ? "file" : "files"} from{" "}
              <span className="font-mono">{manifest.rootName}</span>
            </p>
            <p className="shrink-0 text-xs text-zinc-500">
              {formatBytes(manifest.totalBytes)} of {formatBytes(FOLDER_LIMITS.maxTotalBytes)}
            </p>
          </div>
          <div className="h-1 w-full overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-zinc-400" style={{ width: `${pct}%` }} />
          </div>

          {manifest.included.length === 0 ? (
            <p className="text-sm text-zinc-400">
              Nothing we can use here. Add a README or a docs folder and try again.
            </p>
          ) : (
            <ul className="max-h-64 overflow-auto text-xs">
              {manifest.included.map((f) => (
                <li key={f.path} className="flex items-center gap-3 border-b border-zinc-800 py-1.5 last:border-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-zinc-200" title={f.path}>
                    {f.path}
                  </span>
                  <span className="shrink-0 text-zinc-500">{KIND_LABEL[f.kind]}</span>
                  <span className="w-16 shrink-0 text-right text-zinc-500">{formatBytes(f.size)}</span>
                </li>
              ))}
            </ul>
          )}

          {manifest.skipped.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
                Skipped {manifest.skipped.length} {manifest.skipped.length === 1 ? "file" : "files"}
              </summary>
              <ul className="mt-2 max-h-48 overflow-auto">
                {manifest.skipped.slice(0, SKIPPED_RENDER_CAP).map((s, i) => (
                  <li key={`${s.path}:${i}`} className="flex gap-3 py-0.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-zinc-500" title={s.path}>
                      {s.path}
                    </span>
                    <span className="shrink-0 text-zinc-600">{REASON_LABEL[s.reason]}</span>
                  </li>
                ))}
                {manifest.skipped.length > SKIPPED_RENDER_CAP && (
                  <li className="py-0.5 text-zinc-600">
                    and {manifest.skipped.length - SKIPPED_RENDER_CAP} more
                  </li>
                )}
              </ul>
            </details>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmFiles}
              disabled={confirmed || manifest.included.length === 0}
              className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
            >
              {confirmed ? "Files selected" : "Use these files"}
            </button>
            <button
              type="button"
              onClick={clear}
              className="rounded-md border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-600"
            >
              Clear
            </button>
          </div>
          <p className="text-xs text-zinc-500">Nothing has been uploaded yet. Only the files listed above will be sent.</p>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
