"use client";
import type { Scene, SceneType } from "@mkt/contracts";
import { WPS, wpsBand } from "@mkt/video";
import { lineMeter, type EditorLine } from "./ad-props";
import { AssetPicker, secs, type FootageItem } from "./asset-picker";

export const SCENE_LABEL: Record<SceneType, string> = {
  HookTitle: "Title",
  KineticText: "Moving text",
  ScreenshotKenBurns: "Screenshot, slow zoom",
  FullPageScroll: "Page scroll",
  DeviceMockup: "In a phone or laptop",
  FeatureCallout: "Feature close-up",
  SplitCompare: "Side by side",
  ProofStrip: "Proof points",
  CtaEndCard: "Closing card",
  RecordingAutoZoom: "Screen recording",
};

const IMAGE_TYPES = new Set<SceneType>(["ScreenshotKenBurns", "FullPageScroll", "DeviceMockup", "FeatureCallout", "SplitCompare"]);

export const field = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-zinc-400 focus:outline-none disabled:opacity-60";

/** Picking a picture can change what kind of scene it is (a recording plays; a screenshot zooms). */
export function withPicture(scene: Scene, asset: FootageItem | null): Scene {
  const { focusBox, device } = scene.visual;
  const keep = { ...(focusBox ? { focusBox } : {}), ...(device ? { device } : {}) };
  if (!asset) return { ...scene, type: scene.type === "ProofStrip" ? "ProofStrip" : "KineticText", visual: { kind: "kineticText" } };
  if (asset.kind === "recording") {
    const end = Math.max(1000, Math.min(asset.durationMs ?? 5000, 6000));
    return { ...scene, type: "RecordingAutoZoom", visual: { kind: "recording", assetId: asset.id, trim: { startMs: 0, endMs: end }, ...keep } };
  }
  const type: SceneType = IMAGE_TYPES.has(scene.type) ? scene.type : "ScreenshotKenBurns";
  const kind = type === "FullPageScroll" ? "fullpageScroll" : type === "DeviceMockup" ? "deviceMockup" : "screenshot";
  return { ...scene, type, visual: { kind, assetId: asset.id, ...keep } };
}

export function WpsMeter({ text, saved }: { text: string; saved: EditorLine | undefined }) {
  const m = lineMeter(text, saved);
  if (!m.words) return <span className="text-xs text-zinc-500">No spoken line</span>;
  if (m.wps === null) {
    return (
      <span className="text-xs text-zinc-500" title="The pace is measured once the line is voiced">
        {m.words} words · about {m.seconds}s once voiced
      </span>
    );
  }
  const band = wpsBand(m.wps);
  const tone = band === "ok" ? "text-emerald-400" : band === "too_fast" ? "text-red-400" : "text-amber-300";
  const note = band === "ok" ? "good pace" : band === "slow" ? "slow, may drag" : band === "fast" ? "fast, may feel rushed" : "too fast, cut some words";
  const pct = Math.min(100, Math.round((m.wps / (WPS.block + 1)) * 100));
  return (
    <span className="flex items-center gap-2 text-xs" title={`Good range: ${WPS.low}–${WPS.high} words a second`}>
      <span className="relative h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
        <span className={`absolute inset-y-0 left-0 ${band === "ok" ? "bg-emerald-500" : band === "too_fast" ? "bg-red-500" : "bg-amber-400"}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={tone}>
        {m.wps} words/s · {note}
      </span>
    </span>
  );
}

function FocusBoxInputs({ scene, onChange, disabled }: { scene: Scene; onChange: (s: Scene) => void; disabled: boolean }) {
  const box = scene.visual.focusBox;
  const set = (k: "x" | "y" | "w" | "h", pct: number) => {
    const next = { ...(box ?? { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }), [k]: Math.min(1, Math.max(0, pct / 100)) };
    onChange({ ...scene, visual: { ...scene.visual, focusBox: next } } as Scene);
  };
  const clear = () => {
    const { focusBox: _f, ...rest } = scene.visual;
    onChange({ ...scene, visual: rest } as Scene);
  };
  return (
    <fieldset className="flex flex-col gap-1 text-xs text-zinc-500" disabled={disabled}>
      <legend className="mb-1">Zoom to (percent of the picture)</legend>
      {box ? (
        <div className="flex flex-wrap items-end gap-2">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <label key={k} className="flex w-20 flex-col gap-0.5">
              {k === "x" ? "From left" : k === "y" ? "From top" : k === "w" ? "Width" : "Height"}
              <input type="number" min={0} max={100} step={1} value={Math.round(box[k] * 100)} onChange={(e) => set(k, Number(e.target.value))} className={field} />
            </label>
          ))}
          <button type="button" onClick={clear} className="pb-2 text-zinc-400 underline underline-offset-2">
            Show the whole picture
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => set("x", 25)} className="self-start text-zinc-300 underline underline-offset-2">
          Zoom in on part of it
        </button>
      )}
    </fieldset>
  );
}

export function SceneEditor({
  slug,
  index,
  count,
  scene,
  footage,
  saved,
  issues,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  slug: string;
  index: number;
  count: number;
  scene: Scene;
  footage: FootageItem[];
  saved: EditorLine | undefined;
  issues: { severity: "block" | "warn"; message: string }[];
  disabled: boolean;
  onChange: (s: Scene) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const v = scene.visual;
  const asset = v.assetId ? footage.find((f) => f.id === v.assetId) : undefined;
  const isRecording = v.kind === "recording";
  const trim = v.trim;
  const setTrim = (k: "startMs" | "endMs", seconds: number) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const cur = trim ?? { startMs: 0, endMs: asset?.durationMs ?? 5000 };
    const next = { ...cur, [k]: k === "endMs" ? Math.max(ms, cur.startMs + 300) : Math.min(ms, cur.endMs - 300) };
    onChange({ ...scene, visual: { ...v, trim: next } } as Scene);
  };

  return (
    <li className="flex flex-col gap-3 rounded-md border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">
          Scene {index + 1} <span className="font-normal text-zinc-500">· {SCENE_LABEL[scene.type]}</span>
        </h4>
        <span className="flex gap-2 text-xs text-zinc-400">
          <button type="button" disabled={disabled || index === 0} onClick={() => onMove(-1)} className="hover:text-zinc-200 disabled:opacity-40" aria-label="Move scene up">
            ↑ Up
          </button>
          <button type="button" disabled={disabled || index === count - 1} onClick={() => onMove(1)} className="hover:text-zinc-200 disabled:opacity-40" aria-label="Move scene down">
            ↓ Down
          </button>
          <button type="button" disabled={disabled || count <= 1} onClick={onRemove} className="hover:text-red-300 disabled:opacity-40">
            Remove
          </button>
        </span>
      </div>

      <AssetPicker slug={slug} footage={footage} value={v.assetId ?? null} allowNone={!disabled} onPick={(a) => onChange(withPicture(scene, a))} />

      {isRecording && (
        <div className="flex flex-wrap items-end gap-2 text-xs text-zinc-500">
          <label className="flex w-24 flex-col gap-0.5">
            Start at (s)
            <input type="number" min={0} step={0.1} disabled={disabled} value={((trim?.startMs ?? 0) / 1000).toFixed(1)} onChange={(e) => setTrim("startMs", Number(e.target.value))} className={field} />
          </label>
          <label className="flex w-24 flex-col gap-0.5">
            End at (s)
            <input type="number" min={0} step={0.1} disabled={disabled} value={((trim?.endMs ?? asset?.durationMs ?? 0) / 1000).toFixed(1)} onChange={(e) => setTrim("endMs", Number(e.target.value))} className={field} />
          </label>
          {asset?.durationMs ? <span className="pb-2">of {secs(asset.durationMs)}</span> : null}
        </div>
      )}

      {v.kind !== "kineticText" && <FocusBoxInputs scene={scene} onChange={onChange} disabled={disabled} />}

      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        On-screen text
        <div className="flex gap-2">
          <input
            value={scene.overlay?.text ?? ""}
            disabled={disabled}
            onChange={(e) => {
              const text = e.target.value;
              if (!text) {
                const { overlay: _o, ...rest } = scene;
                onChange(rest);
              } else onChange({ ...scene, overlay: { text, position: scene.overlay?.position ?? "bottom" } });
            }}
            placeholder="A few words, or leave empty"
            className={field}
          />
          <select
            value={scene.overlay?.position ?? "bottom"}
            disabled={disabled || !scene.overlay}
            onChange={(e) => scene.overlay && onChange({ ...scene, overlay: { ...scene.overlay, position: e.target.value as "top" | "center" | "bottom" } })}
            className={`${field} w-28`}
            aria-label="Where the on-screen text sits"
          >
            <option value="top">Top</option>
            <option value="center">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
      </label>

      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        Voice line
        <textarea
          value={scene.vo ?? ""}
          disabled={disabled}
          rows={2}
          onChange={(e) => {
            const vo = e.target.value;
            if (!vo) {
              const { vo: _v, ...rest } = scene;
              onChange(rest);
            } else onChange({ ...scene, vo });
          }}
          className={field}
        />
        <WpsMeter text={scene.vo ?? ""} saved={saved} />
      </label>

      {issues.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {issues.map((i, k) => (
            <li key={k} className={i.severity === "block" ? "text-red-400" : "text-amber-300"}>
              {i.severity === "block" ? "Must fix: " : "Check: "}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
