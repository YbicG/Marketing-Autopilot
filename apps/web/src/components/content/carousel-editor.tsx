"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CAROUSEL_TEMPLATES, countChars, type CarouselTemplate, type SocialPlatform } from "@mkt/contracts";
import { postJson } from "@/lib/post-json";
import { ApproveButton } from "./approve-button";
import { IssueList, POST_STATE_LABEL } from "./status";

export interface EditorSlide {
  template: CarouselTemplate;
  headline: string;
  body: string | null;
  assetId: string | null;
}

export interface CarouselVariantView {
  id: string;
  platform: SocialPlatform;
  label: string;
  output: string;
  caption: { text: string; hashtags: string[] };
  captionLimit: number;
  renderedAssetIds: string[];
  pdf: boolean;
  rendering: boolean;
  issues: { severity: "block" | "warn"; message: string }[];
  posts: { id: string; state: string; when: string }[];
  lockedReason: string | null;
}

const TEMPLATE_LABEL: Record<CarouselTemplate, string> = {
  hero: "Opening slide",
  problem: "The problem",
  feature: "A feature",
  steps: "Steps",
  proof: "Proof",
  cta: "What to do next",
};

const HEADLINE_WORDS = 12;
const BODY_WORDS = 40;
const MAX = 10;
const MIN = 3;
const words = (s: string | null) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);
const parseTags = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((h) => h.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean);

/** Swipe post editor (§2.3, §5.5): slides shared by every platform, a caption per platform. */
export function CarouselEditor({
  slug,
  initialSlides,
  variants,
  screenshots,
  contrastByTemplate,
}: {
  slug: string;
  initialSlides: EditorSlide[];
  variants: CarouselVariantView[];
  screenshots: { id: string; caption: string }[];
  /** Contrast warnings per template for this product's colours (server-computed, same maths as the renderer). */
  contrastByTemplate: Record<CarouselTemplate, string[]>;
}) {
  const router = useRouter();
  const [slides, setSlides] = useState<EditorSlide[]>(initialSlides);
  const [captions, setCaptions] = useState(() => Object.fromEntries(variants.map((v) => [v.platform, { text: v.caption.text, tags: v.caption.hashtags.map((h) => `#${h}`).join(" ") }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = variants.find((v) => v.lockedReason)?.lockedReason ?? null;
  const rendering = variants.some((v) => v.rendering && !v.issues.some((i) => i.severity === "block"));

  // Stills render on the server after a save; refresh until they're in (render.still has no live feed).
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => router.refresh(), 5_000);
    const stop = setTimeout(() => clearInterval(t), 10 * 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [rendering, router]);

  const set = (i: number, patch: Partial<EditorSlide>) => setSlides((xs) => xs.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setSlides((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const next = [...xs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  async function save() {
    const first = variants[0];
    if (!first) return;
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/variants/${first.id}/slides`, {
      slides: slides.map((s) => ({ ...s, body: s.body?.trim() ? s.body : null })),
      captions: Object.fromEntries(Object.entries(captions).map(([p, c]) => [p, { text: c.text, hashtags: parseTags(c.tags) }])),
    });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    router.refresh();
  }

  const pending = variants.flatMap((v) => v.posts.filter((p) => p.state === "pending_approval").map((p) => p.id));
  const field = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-400 focus:outline-none disabled:opacity-60";

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-label="Rendered slides">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">What gets posted</h2>
          <span className="flex items-center gap-3">
            <ApproveButton slug={slug} postIds={pending} label={`Approve ${pending.length === 1 ? "it" : `all ${pending.length}`}`} />
            <Link href={`/p/${encodeURIComponent(slug)}/queue`} className="text-sm text-zinc-400 underline underline-offset-2">
              Skip or move it in the Queue
            </Link>
          </span>
        </div>
        {variants.map((v) => (
          <div key={v.id} className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3">
            <p className="text-sm">
              <span className="font-medium">{v.label}</span> <span className="text-zinc-500">· {v.output}</span>
              {v.rendering && <span className="ml-2 text-xs text-sky-300">{v.renderedAssetIds.length ? "Updating the images…" : "Making the images…"}</span>}
            </p>
            {v.pdf ? (
              v.renderedAssetIds[0] ? (
                <a href={`/api/media/${v.renderedAssetIds[0]}?dl=1`} className="text-sm underline underline-offset-2" download>
                  Download the PDF
                </a>
              ) : null
            ) : (
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {v.renderedAssetIds.map((id, i) => (
                  <li key={id} className="shrink-0">
                    <img src={`/api/media/${id}`} alt={`Slide ${i + 1} for ${v.label}`} loading="lazy" className="h-48 rounded border border-zinc-800 bg-zinc-900 object-contain" />
                  </li>
                ))}
              </ul>
            )}
            {v.posts.map((p) => (
              <p key={p.id} className="text-xs text-zinc-500">
                {p.when} · {POST_STATE_LABEL[p.state] ?? p.state}
              </p>
            ))}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label="Slides">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Slides</h2>
          <span className="text-xs text-zinc-500">
            {slides.length} of {MIN}–{MAX}
          </span>
        </div>
        <ol className="flex flex-col gap-3">
          {slides.map((s, i) => {
            const hw = words(s.headline);
            const bw = words(s.body);
            const live = [
              ...(!s.headline.trim() ? ["Every slide needs a headline."] : []),
              ...(hw > HEADLINE_WORDS ? [`Headline is ${hw} words; aim for ${HEADLINE_WORDS} or fewer.`] : []),
              ...(bw > BODY_WORDS ? [`Body is ${bw} words; aim for ${BODY_WORDS} or fewer.`] : []),
              ...(contrastByTemplate[s.template] ?? []).filter((m) => s.body?.trim() || !m.includes("body")),
            ];
            const all = [...new Set(live)];
            return (
              <li key={i} className="grid gap-3 rounded-md border border-zinc-800 p-3 sm:grid-cols-[7rem_1fr]">
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">Slide {i + 1}</span>
                  {s.assetId ? (
                    <img src={`/api/media/${s.assetId}?v=preview`} alt="Screenshot on this slide" className="h-20 w-28 rounded border border-zinc-800 object-cover object-top" />
                  ) : (
                    <span className="flex h-20 w-28 items-center justify-center rounded border border-dashed border-zinc-800 text-xs text-zinc-600">Text only</span>
                  )}
                  {!locked && (
                    <span className="flex gap-2 text-xs text-zinc-500">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="hover:text-zinc-200 disabled:opacity-30" aria-label={`Move slide ${i + 1} up`}>
                        ↑
                      </button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === slides.length - 1} className="hover:text-zinc-200 disabled:opacity-30" aria-label={`Move slide ${i + 1} down`}>
                        ↓
                      </button>
                      {slides.length > MIN && (
                        <button type="button" onClick={() => setSlides((xs) => xs.filter((_, k) => k !== i))} className="hover:text-zinc-200">
                          Remove
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs text-zinc-500">
                      Layout
                      <select value={s.template} onChange={(e) => set(i, { template: e.target.value as CarouselTemplate })} disabled={!!locked} className={field}>
                        {CAROUSEL_TEMPLATES.map((t) => (
                          <option key={t} value={t}>
                            {TEMPLATE_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-zinc-500">
                      Screenshot
                      <select value={s.assetId ?? ""} onChange={(e) => set(i, { assetId: e.target.value || null })} disabled={!!locked} className={field}>
                        <option value="">None (text only)</option>
                        {screenshots.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.caption.slice(0, 60)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="flex flex-col gap-1 text-xs text-zinc-500">
                    Headline · {hw} words
                    <input value={s.headline} onChange={(e) => set(i, { headline: e.target.value })} disabled={!!locked} className={field} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-zinc-500">
                    Body · {bw} words
                    <textarea value={s.body ?? ""} onChange={(e) => set(i, { body: e.target.value })} rows={2} disabled={!!locked} className={field} />
                  </label>
                  {all.length > 0 ? (
                    <ul className="flex flex-col gap-0.5 text-xs text-amber-300">
                      {all.map((m) => (
                        <li key={m}>Check: {m}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-emerald-400">Easy to read.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {!locked && slides.length < MAX && (
          <button
            type="button"
            onClick={() => setSlides((xs) => [...xs.slice(0, -1), { template: "feature", headline: "", body: null, assetId: null }, ...xs.slice(-1)])}
            className="self-start text-sm text-zinc-400 underline underline-offset-2"
          >
            Add a slide
          </button>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Captions">
        <h2 className="text-lg font-semibold">Captions</h2>
        <div className={`grid gap-4 ${variants.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {variants.map((v) => {
            const c = captions[v.platform] ?? { text: "", tags: "" };
            const tags = parseTags(c.tags);
            const n = countChars(v.platform, tags.length ? `${c.text}\n\n${tags.map((h) => `#${h}`).join(" ")}` : c.text);
            return (
              <div key={v.id} className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3">
                <p className="text-sm font-medium">{v.label}</p>
                <textarea
                  value={c.text}
                  onChange={(e) => setCaptions((m) => ({ ...m, [v.platform]: { ...c, text: e.target.value } }))}
                  rows={4}
                  disabled={!!locked}
                  aria-label={`${v.label} caption`}
                  className={field}
                />
                <span className={`text-xs ${n > v.captionLimit ? "text-red-400" : "text-zinc-500"}`}>
                  {n} / {v.captionLimit}
                </span>
                <input
                  value={c.tags}
                  onChange={(e) => setCaptions((m) => ({ ...m, [v.platform]: { ...c, tags: e.target.value } }))}
                  disabled={!!locked}
                  placeholder="#college #studytok"
                  aria-label={`${v.label} hashtags`}
                  className={field}
                />
                <IssueList issues={v.issues} />
              </div>
            );
          })}
        </div>
      </section>

      {locked ? (
        <p className="text-sm text-zinc-400">{locked}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void save()} disabled={busy} className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60">
            {busy ? "Saving…" : "Save and remake the images"}
          </button>
          <span className="text-xs text-zinc-500">Images are made on your server for free. Saving sends approved versions back for approval.</span>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
