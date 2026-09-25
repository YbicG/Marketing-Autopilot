"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { HookStyle, HookVariant, Scene, SpecIssue, VideoFormat, VideoSpec } from "@mkt/contracts";
import { lintSpec, type SafeZonePlatform } from "@mkt/video";
import { IssueList } from "@/components/content/status";
import { postJson } from "@/lib/post-json";
import { buildPreviewProps, HOOK_KEY, CTA_KEY, linesForSpec, normalizeLine, voDurationsFor, type EditorLine } from "./ad-props";
import type { FootageItem } from "./asset-picker";
import { FinalFiles, type FinalFile, type FinalPost, type FinalRender } from "./final-files";
import { AdPlayer } from "./player";
import { field, SceneEditor, WpsMeter } from "./scene-editor";

type Issue = { severity: "block" | "warn"; message: string; code: string; sceneId?: string };

export interface VideoEditorProps {
  slug: string;
  itemId: string;
  status: string;
  needsYouReason: string | null;
  spec: VideoSpec;
  specId: string;
  version: number | null;
  editedBy: string | null;
  savedIssues: Issue[];
  lines: Record<string, EditorLine>;
  musicAssetId: string | null;
  noVoice: boolean;
  hasVoiceKey: boolean;
  moreHooks: HookVariant[];
  checks: { idx: number; wps: number | null; problems: string[] }[];
  hookOrder: number[];
  hookOrderSource: "judge" | "checks";
  finalizeHash: string | null;
  finalizeConfirmed: boolean;
  final: { specHash: string; tier: string; judgeIssues: SpecIssue[] } | null;
  renders: FinalRender[];
  files: FinalFile[];
  posts: FinalPost[];
  footage: FootageItem[];
  publicClaimRefs: string[];
  verifiedClaimRefs: string[];
  prices: { hooksMore: string; changeRequest: string; finalize: string; revoicePerWordMicros: number };
}

const FORMATS: { value: VideoFormat; label: string }[] = [
  { value: "9x16", label: "9:16" },
  { value: "1x1", label: "1:1" },
  { value: "16x9", label: "16:9" },
];

const ZONES: { value: SafeZonePlatform | ""; label: string }[] = [
  { value: "", label: "Off" },
  { value: "all", label: "Every app" },
  { value: "tiktok", label: "TikTok" },
  { value: "meta", label: "Instagram" },
  { value: "yt_short", label: "YouTube" },
];

const MOODS = ["upbeat", "calm", "focused", "playful", "confident", "warm"];

const STYLE_LABEL: Record<HookStyle, string> = {
  pain_callout: "Names the problem",
  speed_demo: "Shows how fast",
  before_after_split: "Before and after",
  pov: "Point of view",
  contrarian: "Goes against the grain",
  question: "Asks a question",
  real_stat: "Real number",
  listicle_disclosed: "Quick list",
  build_in_public: "Behind the scenes",
  reply_to_complaint: "Answers a complaint",
};

const BUSY_STATES = new Set(["planned", "generating", "finalizing", "skipped"]);

/** "~$0.004" on the client, where formatUsd (core) isn't available. */
const usd = (m: number) => `~$${(m / 1_000_000).toFixed(m < 10_000 ? 3 : 2)}`;

/** A diff path in plain words ("scenes.1.vo" → "Scene 2 · voice line"). */
function pathLabel(path: string): string {
  const parts = path.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const n = Number(parts[i + 1]);
    if (p === "scenes" && Number.isInteger(n)) {
      out.push(`Scene ${n + 1}`);
      i++;
    } else if (p === "hookVariants" && Number.isInteger(n)) {
      out.push(`Opening line ${n + 1}`);
      i++;
    } else if (p === "cta") out.push("Closing line");
    else if (p === "vo") out.push("voice line");
    else if (p === "onScreen" || p === "overlay") out.push("on-screen text");
    else if (p === "text" || p === "position" && out.at(-1) === "on-screen text") out.push(p === "text" ? "" : "position");
    else if (p === "visual") out.push("picture");
    else if (p === "targetSeconds") out.push("Length");
    else if (p === "music") out.push("Music");
    else if (p === "captions") out.push("Captions");
    else if (p === "voice") out.push("Voice");
    else out.push(p);
  }
  return out.filter(Boolean).join(" · ");
}

const show = (v: unknown) => (v === undefined || v === null ? "(none)" : typeof v === "string" ? `“${v}”` : JSON.stringify(v));

export function VideoEditor(p: VideoEditorProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<VideoSpec>(p.spec);
  const [previewIdx, setPreviewIdx] = useState(p.hookOrder[0] ?? 0);
  const [zone, setZone] = useState<SafeZonePlatform | "">("");
  const [busy, setBusy] = useState<"save" | "more" | "ask" | "finalize" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [ask, setAsk] = useState("");
  const [proposal, setProposal] = useState<{ spec: VideoSpec; diff: { path: string; before: unknown; after: unknown }[]; issues: Issue[]; baseSpecId: string } | null>(null);
  const [replaceIdx, setReplaceIdx] = useState(0);

  const locked = BUSY_STATES.has(p.status);
  const dirty = JSON.stringify(draft) !== JSON.stringify(p.spec);

  // Finalizing and first drafts finish on the worker: keep the page fresh until they do.
  useEffect(() => {
    if (p.status !== "finalizing" && p.status !== "generating") return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [p.status, router]);

  const { lines: previewLines, stale } = useMemo(() => linesForSpec(draft, p.lines), [draft, p.lines]);
  const assetMeta = useMemo(() => Object.fromEntries(p.footage.map((f) => [f.id, { width: f.width, height: f.height, durationMs: f.durationMs }])), [p.footage]);
  const props = useMemo(() => {
    try {
      return buildPreviewProps({ spec: draft, lines: p.lines, musicAssetId: p.musicAssetId, noVoice: p.noVoice, hookIdx: previewIdx, assetMeta, showSafeZones: zone || null });
    } catch {
      return null;
    }
  }, [draft, p.lines, p.musicAssetId, p.noVoice, previewIdx, assetMeta, zone]);

  // lintSpec on the draft, live: the same checks the server runs when you save.
  const issues: Issue[] = useMemo(() => {
    try {
      return lintSpec(draft, {
        assets: Object.fromEntries(p.footage.map((f) => [f.id, { kind: f.kind, durationMs: f.durationMs, width: f.width, height: f.height }])),
        publicClaimRefs: new Set(p.publicClaimRefs),
        verifiedClaimRefs: new Set(p.verifiedClaimRefs),
        voDurationsMs: voDurationsFor(previewLines, previewIdx),
      }).map((i) => ({ severity: i.severity, message: i.message, code: i.code, ...(i.sceneId ? { sceneId: i.sceneId } : {}) }));
    } catch {
      return p.savedIssues;
    }
  }, [draft, p.footage, p.publicClaimRefs, p.verifiedClaimRefs, p.savedIssues, previewLines, previewIdx]);
  const blocking = issues.some((i) => i.severity === "block");
  const general = issues.filter((i) => !i.sceneId);

  // Save price: changed spoken lines are re-voiced on the draft voice.
  const changedWords = stale.reduce((n, key) => {
    const text = key === CTA_KEY ? draft.cta.vo : key.startsWith("hook:") ? (draft.hookVariants[Number(key.slice(5))]?.vo ?? "") : (draft.scenes.find((s) => s.id === key)?.vo ?? "");
    return n + (normalizeLine(text) ? normalizeLine(text).split(" ").length : 0);
  }, 0);
  const savePrice = p.hasVoiceKey && changedWords > 0 ? Math.max(1, Math.round(changedWords * p.prices.revoicePerWordMicros)) : 0;
  const changedLines = p.hasVoiceKey ? stale.length : 0;

  const setHook = (i: number, patch: Partial<HookVariant>) => setDraft((d) => ({ ...d, hookVariants: d.hookVariants.map((h, k) => (k === i ? { ...h, ...patch } : h)) }));
  const setScene = (i: number, s: Scene) => setDraft((d) => ({ ...d, scenes: d.scenes.map((x, k) => (k === i ? s : x)) }));
  const moveScene = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const scenes = [...d.scenes];
      const j = i + dir;
      if (j < 0 || j >= scenes.length) return d;
      [scenes[i], scenes[j]] = [scenes[j]!, scenes[i]!];
      return { ...d, scenes };
    });
  const removeScene = (i: number) => setDraft((d) => (d.scenes.length <= 1 ? d : { ...d, scenes: d.scenes.filter((_, k) => k !== i), transitions: d.transitions.filter((t) => t.sceneId !== d.scenes[i]!.id) }));

  async function save(spec: VideoSpec, source: "user" | "change_request", baseSpecId = p.specId) {
    setBusy("save");
    setMsg(null);
    const out = await postJson<{ specId: string; issues: Issue[] }>(`/api/videos/${p.itemId}/spec`, { spec, baseSpecId, source });
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    setProposal(null);
    setMsg({ tone: "ok", text: "Saved as a new version." });
    router.refresh();
  }

  async function writeMore() {
    setBusy("more");
    setMsg(null);
    const out = await postJson<{ more: HookVariant[] }>(`/api/videos/${p.itemId}/hooks-more`, {});
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    setMsg({ tone: "ok", text: `${out.data.more.length} more opening lines are below the list.` });
    router.refresh();
  }

  async function askForChanges() {
    setBusy("ask");
    setMsg(null);
    setProposal(null);
    const out = await postJson<{ spec: VideoSpec; diff: { path: string; before: unknown; after: unknown }[]; issues: Issue[]; baseSpecId: string }>(`/api/videos/${p.itemId}/change-request`, { request: ask });
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    if (!out.data.diff.length) return setMsg({ tone: "err", text: "That request didn't change anything. Try saying it another way." });
    setProposal(out.data);
  }

  async function finalize() {
    if (!p.finalizeHash) return;
    setBusy("finalize");
    setMsg(null);
    const out = await postJson(`/api/videos/${p.itemId}/finalize`, { shownHash: p.finalizeHash });
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    setMsg({ tone: "ok", text: "Finalizing. The 3 versions show up here in a few minutes." });
    router.refresh();
  }

  const finalStale = p.final && !p.finalizeConfirmed && (p.status === "final_ready" || p.status === "approved" || p.renders.length > 0);
  const finalizeBlocked = locked ? "Wait for this video to finish first." : dirty ? "Save your changes first." : blocking ? "Fix the problems marked “Must fix” first." : null;

  return (
    <div className="flex flex-col gap-6">
      {p.status === "needs_you" && p.needsYouReason && <p className="rounded-md border border-amber-800 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">{p.needsYouReason}</p>}
      {p.noVoice && (
        <p className="rounded-md border border-zinc-800 px-4 py-3 text-sm text-zinc-400">
          {p.hasVoiceKey ? "This preview has no voice yet." : "No voice key yet, so this video uses captions and music only."}{" "}
          <a href="/settings/keys" className="underline underline-offset-2">
            Add a voice key
          </a>{" "}
          to hear it spoken.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        {/* Preview */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex rounded-md border border-zinc-700 text-xs" role="tablist" aria-label="Shape">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="tab"
                  aria-selected={draft.format === f.value}
                  disabled={locked}
                  onClick={() => setDraft((d) => ({ ...d, format: f.value }))}
                  className={`px-2.5 py-1 ${draft.format === f.value ? "bg-zinc-200 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              Safe zone
              <select value={zone} onChange={(e) => setZone(e.target.value as SafeZonePlatform | "")} className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200">
                {ZONES.map((z) => (
                  <option key={z.value} value={z.value}>
                    {z.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={draft.format === "16x9" ? "" : draft.format === "1x1" ? "mx-auto w-full max-w-[380px]" : "mx-auto w-full max-w-[300px]"}>
            {props ? <AdPlayer props={props} /> : <p className="text-sm text-amber-300">The preview can't be drawn with these settings. Undo the last change.</p>}
          </div>
          <p className="text-xs text-zinc-500">
            Previewing opening line {previewIdx + 1}.{stale.length > 0 && !p.noVoice ? " Changed lines play silent until you save." : ""}
            {zone ? " The shaded area may be covered by the app's buttons." : ""}
          </p>
          <IssueList issues={general} />
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3" aria-label="Opening lines">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Opening lines</h3>
              <button
                type="button"
                onClick={() => void writeMore()}
                disabled={busy !== null || locked}
                className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
              >
                {busy === "more" ? "Writing…" : `Write 3 more · ~${p.prices.hooksMore}`}
              </button>
            </div>
            <p className="text-xs text-zinc-500">
              Each is the first 1–3 seconds of one version. {p.hookOrderSource === "judge" ? "Ranked by the final check." : "Ranked by the checks below, best first."}
            </p>
            <ol className="flex flex-col gap-3">
              {p.hookOrder.map((i, rank) => {
                const h = draft.hookVariants[i];
                if (!h) return null;
                const saved = p.spec.hookVariants[i];
                const unchanged = saved && saved.vo === h.vo && saved.onScreen === h.onScreen;
                const check = p.checks[i];
                return (
                  <li key={i} className={`flex flex-col gap-2 rounded-md border p-3 ${previewIdx === i ? "border-zinc-400" : "border-zinc-800"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        #{rank + 1} <span className="font-normal text-zinc-500">· {STYLE_LABEL[h.style] ?? h.style}</span>
                      </span>
                      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                        <input type="radio" name="preview-line" checked={previewIdx === i} onChange={() => setPreviewIdx(i)} />
                        Preview this one
                      </label>
                    </div>
                    <label className="flex flex-col gap-1 text-xs text-zinc-500">
                      On-screen text
                      <input value={h.onScreen} disabled={locked} onChange={(e) => setHook(i, { onScreen: e.target.value })} className={field} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-zinc-500">
                      Spoken
                      <textarea value={h.vo} rows={2} disabled={locked} onChange={(e) => setHook(i, { vo: e.target.value })} className={field} />
                      <WpsMeter text={h.vo} saved={p.lines[HOOK_KEY(i)]} />
                    </label>
                    {unchanged && check ? (
                      check.problems.length ? (
                        <ul className="text-xs text-amber-300">
                          {check.problems.map((x, k) => (
                            <li key={k}>Check: {x}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-emerald-400">Passes the checks.</p>
                      )
                    ) : (
                      <p className="text-xs text-zinc-500">Checked again when you save.</p>
                    )}
                  </li>
                );
              })}
            </ol>
            {p.moreHooks.length > 0 && (
              <div className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">More opening lines</h4>
                  <label className="flex items-center gap-2 text-xs text-zinc-500">
                    Replace
                    <select value={replaceIdx} onChange={(e) => setReplaceIdx(Number(e.target.value))} className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200">
                      {draft.hookVariants.map((_, k) => (
                        <option key={k} value={k}>
                          line {k + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <ul className="flex flex-col gap-2">
                  {p.moreHooks.map((h, k) => {
                    const inUse = draft.hookVariants.some((x) => x.vo === h.vo && x.onScreen === h.onScreen);
                    return (
                      <li key={k} className="flex flex-wrap items-start justify-between gap-2 border-t border-zinc-800 pt-2 text-sm">
                        <span className="flex flex-col">
                          <span>{h.onScreen}</span>
                          <span className="text-xs text-zinc-500">
                            “{h.vo}” · {STYLE_LABEL[h.style] ?? h.style}
                          </span>
                        </span>
                        <button
                          type="button"
                          disabled={locked || inUse}
                          onClick={() => setDraft((d) => ({ ...d, hookVariants: d.hookVariants.map((x, j) => (j === replaceIdx ? h : x)) }))}
                          className="text-xs text-zinc-300 underline underline-offset-2 disabled:no-underline disabled:opacity-50"
                        >
                          {inUse ? "In use" : `Use as line ${replaceIdx + 1}`}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-label="Scenes">
            <h3 className="font-semibold">Scenes</h3>
            <ol className="flex flex-col gap-3">
              {draft.scenes.map((s, i) => (
                <SceneEditor
                  key={s.id}
                  slug={p.slug}
                  index={i}
                  count={draft.scenes.length}
                  scene={s}
                  footage={p.footage}
                  saved={p.lines[s.id]}
                  issues={issues.filter((x) => x.sceneId === s.id)}
                  disabled={locked}
                  onChange={(next) => setScene(i, next)}
                  onMove={(dir) => moveScene(i, dir)}
                  onRemove={() => removeScene(i)}
                />
              ))}
            </ol>
            <div className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3">
              <h4 className="text-sm font-medium">Closing line</h4>
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                On-screen text
                <input value={draft.cta.onScreen} disabled={locked} onChange={(e) => setDraft((d) => ({ ...d, cta: { ...d.cta, onScreen: e.target.value } }))} className={field} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                Spoken
                <textarea value={draft.cta.vo} rows={2} disabled={locked} onChange={(e) => setDraft((d) => ({ ...d, cta: { ...d.cta, vo: e.target.value } }))} className={field} />
                <WpsMeter text={draft.cta.vo} saved={p.lines[CTA_KEY]} />
              </label>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2" aria-label="Sound and length">
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Voice
              <input
                value={draft.voice.voiceId}
                disabled={locked || !p.hasVoiceKey}
                onChange={(e) => setDraft((d) => ({ ...d, voice: { ...d.voice, voiceId: e.target.value.trim() } }))}
                placeholder="Voice id from your voice account"
                className={field}
              />
              <span>{p.hasVoiceKey ? "Changing the voice re-voices every line when you save." : "Add a voice key in Settings → Keys to choose a voice."}</span>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Music mood
              <select value={MOODS.includes(draft.music.mood) ? draft.music.mood : "__custom"} disabled={locked} onChange={(e) => e.target.value !== "__custom" && setDraft((d) => ({ ...d, music: { ...d.music, mood: e.target.value } }))} className={field}>
                {MOODS.map((m) => (
                  <option key={m} value={m}>
                    {m[0]!.toUpperCase() + m.slice(1)}
                  </option>
                ))}
                {!MOODS.includes(draft.music.mood) && <option value="__custom">{draft.music.mood}</option>}
              </select>
              <span>{draft.music.trackAssetId ? "Uses the chosen track." : "Music is made at the final length when you finalize."}</span>
            </label>
            <fieldset className="flex flex-col gap-1 text-xs text-zinc-500" disabled={locked}>
              <legend className="mb-1">Captions</legend>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={draft.captions.enabled || p.noVoice} disabled={p.noVoice} onChange={(e) => setDraft((d) => ({ ...d, captions: { ...d.captions, enabled: e.target.checked } }))} />
                Show the spoken words on screen
              </label>
              <select value={draft.captions.style} onChange={(e) => setDraft((d) => ({ ...d, captions: { ...d.captions, style: e.target.value as "tiktok" | "clean" } }))} className={field} aria-label="Caption style">
                <option value="tiktok">Big, word by word</option>
                <option value="clean">Small and clean</option>
              </select>
              {p.noVoice && <span>Always on while there's no voice.</span>}
            </fieldset>
            <fieldset className="flex flex-col gap-1 text-xs text-zinc-500" disabled={locked}>
              <legend className="mb-1">Length</legend>
              <div className="flex rounded-md border border-zinc-700 text-sm">
                {([15, 30, 45] as const).map((n) => (
                  <button key={n} type="button" onClick={() => setDraft((d) => ({ ...d, targetSeconds: n }))} className={`flex-1 px-2 py-1 ${draft.targetSeconds === n ? "bg-zinc-200 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"}`}>
                    {n}s
                  </button>
                ))}
              </div>
              <span>The target. The video runs as long as its lines take to say.</span>
            </fieldset>
          </section>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-zinc-800 bg-zinc-950/95 py-3">
            <button
              type="button"
              onClick={() => void save(draft, "user")}
              disabled={busy !== null || !dirty || locked}
              className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : changedLines > 0 ? `Save · re-voices ${changedLines} line${changedLines === 1 ? "" : "s"} ${usd(savePrice)}` : "Save"}
            </button>
            {dirty && (
              <button type="button" onClick={() => setDraft(p.spec)} disabled={busy !== null} className="text-sm text-zinc-400 underline underline-offset-2">
                Undo my changes
              </button>
            )}
            {msg && <span className={`text-sm ${msg.tone === "ok" ? "text-emerald-400" : "text-amber-300"}`}>{msg.text}</span>}
            {!msg && (p.status === "final_ready" || p.status === "approved") && dirty && (
              <span className="text-xs text-amber-300">Saving changes the final files: they'll need finalizing and approving again.</span>
            )}
          </div>

          <section className="flex flex-col gap-2 rounded-md border border-zinc-800 p-4" aria-label="Ask for changes">
            <h3 className="font-semibold">Ask for changes</h3>
            <textarea
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              rows={2}
              disabled={locked || dirty}
              placeholder="Like “make scene 2 shorter” or “end on the calendar view”"
              className={field}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void askForChanges()}
                disabled={busy !== null || locked || dirty || ask.trim().length < 3}
                className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
              >
                {busy === "ask" ? "Thinking…" : `Ask · ~${p.prices.changeRequest}`}
              </button>
              {dirty && <span className="text-xs text-zinc-500">Save or undo your edits first.</span>}
            </div>
            {proposal && (
              <div className="flex flex-col gap-2 rounded-md border border-zinc-700 p-3">
                <h4 className="text-sm font-medium">Proposed changes</h4>
                <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto text-xs">
                  {proposal.diff.map((d, k) => (
                    <li key={k} className="flex flex-col">
                      <span className="text-zinc-300">{pathLabel(d.path)}</span>
                      <span className="text-zinc-500 line-through">{show(d.before)}</span>
                      <span className="text-zinc-200">{show(d.after)}</span>
                    </li>
                  ))}
                </ul>
                <IssueList issues={proposal.issues} />
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void save(proposal.spec, "change_request", proposal.baseSpecId)}
                    disabled={busy !== null}
                    className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
                  >
                    {busy === "save" ? "Saving…" : "Apply and save"}
                  </button>
                  <button type="button" onClick={() => setDraft(proposal.spec)} disabled={busy !== null} className="text-sm text-zinc-300 underline underline-offset-2">
                    Edit it first
                  </button>
                  <button type="button" onClick={() => setProposal(null)} className="text-sm text-zinc-400 underline underline-offset-2">
                    Discard
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2 rounded-md border border-zinc-800 p-4" aria-label="Finalize">
            <h3 className="font-semibold">Finalize</h3>
            <p className="text-sm text-zinc-400">
              Makes the 3 finished versions, one per opening line: the final voice, a check that every word was said right, music at the exact length, then files for each app and a last look at every frame.
            </p>
            {finalStale && <p className="text-xs text-amber-300">You changed the video after finalizing. Finalize again to update the files.</p>}
            {p.status === "finalizing" ? (
              <p className="text-sm text-sky-300">Finalizing now. This page updates itself.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void finalize()}
                  disabled={busy !== null || !!finalizeBlocked || !p.finalizeHash}
                  className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-sky-400 disabled:opacity-50"
                >
                  {busy === "finalize" ? "Starting…" : `Finalize 3 versions · ~${p.prices.finalize}`}
                </button>
                {finalizeBlocked && <span className="text-xs text-zinc-500">{finalizeBlocked}</span>}
              </div>
            )}
          </section>
        </div>
      </div>

      {p.final && p.renders.length > 0 && (
        <FinalFiles
          itemId={p.itemId}
          slug={p.slug}
          status={p.status}
          tier={p.final.tier}
          judgeIssues={p.final.judgeIssues.map((i) => ({ severity: i.severity, message: i.message }))}
          openingLines={p.spec.hookVariants.map((h) => h.onScreen)}
          renders={p.renders}
          files={p.files}
          posts={p.posts}
        />
      )}
    </div>
  );
}
