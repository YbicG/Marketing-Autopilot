"use client";
import { useEffect, useState } from "react";
import { TikTokOptions, TIKTOK_BRANDED_NOT_PRIVATE_TEXT, tiktokConsentText, tiktokContentLabel } from "@mkt/contracts";
import { postJson } from "@/lib/post-json";
import type { CreatorInfoJson, Issue, PostDetailJson } from "./types";

/**
 * TikTok composer (§2.3, §8 "TikTok composer UX", D17). Rules: "Who can view" has no default;
 * comments/duet/stitch start off; commercial content starts off, with a warning on promotional
 * posts; Branded content disables "Only me" and shows the policy text; the consent line is TikTok's
 * wording verbatim; the AI label is automatic for tiers B/C; blocked when creator_info says the
 * account can't post. The server re-checks everything with validateTikTokComposer on save and at prepare.
 */

const PRIVACY: { value: string; label: string }[] = [
  { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
  { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
  { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
  { value: "SELF_ONLY", label: "Only me" },
];

interface Commercial {
  enabled: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
}

interface Draft {
  privacyLevel: string | null;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  commercialContent: Commercial;
  autoAddMusic: boolean;
  postMode: "direct" | "drafts";
  markAsAi: boolean;
}

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

function fromStored(o: Record<string, unknown>): Draft {
  const c = (o.commercialContent ?? {}) as Record<string, unknown>;
  return {
    // No default, ever: an unset audience stays unset until the person picks one.
    privacyLevel: typeof o.privacyLevel === "string" ? o.privacyLevel : null,
    disableComment: bool(o.disableComment, true),
    disableDuet: bool(o.disableDuet, true),
    disableStitch: bool(o.disableStitch, true),
    commercialContent: { enabled: bool(c.enabled, false), yourBrand: bool(c.yourBrand, false), brandedContent: bool(c.brandedContent, false) },
    autoAddMusic: bool(o.autoAddMusic, false),
    postMode: o.postMode === "drafts" ? "drafts" : "direct",
    markAsAi: bool(o.markAsAi, false),
  };
}

export function TikTokComposer({ post, onSaved }: { post: PostDetailJson; onSaved: (state: string) => void }) {
  const [d, setD] = useState<Draft>(() => fromStored(post.platformOptions));
  const [info, setInfo] = useState<CreatorInfoJson | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(post.connection?.handle ?? null);
  const [madeForKids, setMadeForKids] = useState<boolean | null>(post.madeForKids);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isVideo = post.media.some((m) => m.mime.startsWith("video/"));
  const aiAuto = post.tier === "B" || post.tier === "C";
  const approved = ["approved", "queued", "paused", "missed"].includes(post.state);

  useEffect(() => {
    let live = true;
    void fetch(`/api/posts/${post.id}/creator-info`)
      .then((r) => r.json() as Promise<{ creatorInfo: CreatorInfoJson | null; handle?: string | null; message: string | null }>)
      .then((j) => {
        if (!live) return;
        setInfo(j.creatorInfo);
        setInfoMsg(j.message);
        if (j.handle) setHandle(j.handle);
      })
      .catch(() => live && setInfoMsg("Couldn't read this TikTok account's settings. Try again in a minute."));
    return () => {
      live = false;
    };
  }, [post.id]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(null);
    setD((cur) => ({ ...cur, [k]: v }));
  };
  const setCommercial = (patch: Partial<Commercial>) => {
    setSaved(null);
    setD((cur) => {
      const c = { ...cur.commercialContent, ...patch };
      if (!c.enabled) {
        c.yourBrand = false;
        c.brandedContent = false;
      }
      // Branded content can't be private: clear "Only me" instead of leaving an invalid pick.
      const privacyLevel = c.enabled && c.brandedContent && cur.privacyLevel === "SELF_ONLY" ? null : cur.privacyLevel;
      return { ...cur, commercialContent: c, privacyLevel };
    });
  };

  const branded = d.commercialContent.enabled && d.commercialContent.brandedContent;
  const allowed = info?.privacyOptions.length ? new Set(info.privacyOptions) : null;
  const blockedByAccount = info ? !info.canPost : false;
  const options = {
    ...(d.privacyLevel ? { privacyLevel: d.privacyLevel } : {}),
    disableComment: d.disableComment || !!info?.commentDisabled,
    disableDuet: isVideo ? d.disableDuet || !!info?.duetDisabled : true,
    disableStitch: isVideo ? d.disableStitch || !!info?.stitchDisabled : true,
    commercialContent: d.commercialContent,
    musicConsent: true as const,
    autoAddMusic: isVideo ? false : d.autoAddMusic,
    postMode: d.postMode,
    disableInboxFallback: d.postMode === "direct",
    markAsAi: aiAuto || d.markAsAi,
  };
  const local = TikTokOptions.safeParse(options);
  const localProblems = local.success ? [] : [...new Set(local.error.issues.map((i) => (i.path[0] === "privacyLevel" && !d.privacyLevel ? "Choose who can see this TikTok." : i.message)))];
  const commercialIncomplete = d.commercialContent.enabled && !d.commercialContent.yourBrand && !d.commercialContent.brandedContent;
  const consent = tiktokConsentText({ commercialContent: d.commercialContent });
  const label = tiktokContentLabel({ commercialContent: d.commercialContent });

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    const out = await postJson<{ state: string; issues: Issue[] }>(`/api/posts/${post.id}/options`, {
      platformOptions: options,
      ...(post.madeForKids === null && madeForKids !== null ? { madeForKids } : {}),
    });
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setIssues(out.data.issues);
    setSaved(approved ? "Saved. Settings changed, so approve this post again." : "Saved.");
    onSaved(out.data.state);
  }

  const box = "flex flex-col gap-2 rounded-md border border-zinc-800 p-3";
  return (
    <section className="flex flex-col gap-3" aria-label="TikTok settings">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">TikTok settings{handle ? ` · @${handle.replace(/^@/, "")}` : ""}</h3>
        {aiAuto && (
          <span className="rounded-full border border-violet-800 px-2 py-0.5 text-xs text-violet-200" title="Set automatically because this post uses AI voice or images">
            AI-generated label: on
          </span>
        )}
      </div>
      {infoMsg && <p className="text-xs text-amber-300">{infoMsg}</p>}
      {blockedByAccount && (
        <p className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          TikTok says this account can&apos;t post right now (it may have hit TikTok&apos;s daily limit). Try again later or pick another day.
        </p>
      )}

      <fieldset className={box}>
        <legend className="px-1 text-sm text-zinc-300">Who can view this post</legend>
        <div className="flex flex-wrap gap-3">
          {PRIVACY.map((p) => {
            const disabled = (branded && p.value === "SELF_ONLY") || (allowed ? !allowed.has(p.value) : false);
            return (
              <label key={p.value} className={`flex items-center gap-2 text-sm ${disabled ? "text-zinc-600" : "text-zinc-200"}`}>
                <input
                  type="radio"
                  name={`privacy-${post.id}`}
                  value={p.value}
                  checked={d.privacyLevel === p.value}
                  disabled={disabled}
                  onChange={() => set("privacyLevel", p.value)}
                />
                {p.label}
              </label>
            );
          })}
        </div>
        {!d.privacyLevel && <p className="text-xs text-amber-300">Pick one. There&apos;s no default.</p>}
        {branded && <p className="text-xs text-zinc-400">{TIKTOK_BRANDED_NOT_PRIVATE_TEXT}</p>}
      </fieldset>

      <fieldset className={box}>
        <legend className="px-1 text-sm text-zinc-300">Let people</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!options.disableComment} disabled={!!info?.commentDisabled} onChange={(e) => set("disableComment", !e.target.checked)} />
          Comment{info?.commentDisabled ? " (turned off in your TikTok settings)" : ""}
        </label>
        {isVideo && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!options.disableDuet} disabled={!!info?.duetDisabled} onChange={(e) => set("disableDuet", !e.target.checked)} />
              Duet{info?.duetDisabled ? " (turned off in your TikTok settings)" : ""}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!options.disableStitch} disabled={!!info?.stitchDisabled} onChange={(e) => set("disableStitch", !e.target.checked)} />
              Stitch{info?.stitchDisabled ? " (turned off in your TikTok settings)" : ""}
            </label>
          </>
        )}
        {!isVideo && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.autoAddMusic} onChange={(e) => set("autoAddMusic", e.target.checked)} />
            Add TikTok&apos;s suggested music to the photos
          </label>
        )}
      </fieldset>

      <fieldset className={box}>
        <legend className="px-1 text-sm text-zinc-300">Disclose post content</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.commercialContent.enabled} onChange={(e) => setCommercial({ enabled: e.target.checked })} />
          This post promotes a brand, product or service
        </label>
        {!d.commercialContent.enabled && post.promotional && (
          <p className="text-xs text-amber-300">
            This post points people to your product. TikTok asks you to turn this on for posts that promote your own business.
          </p>
        )}
        {d.commercialContent.enabled && (
          <div className="flex flex-col gap-2 pl-6">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={d.commercialContent.yourBrand} onChange={(e) => setCommercial({ yourBrand: e.target.checked })} />
              Your brand (you&apos;re promoting yourself or your own business)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={d.commercialContent.brandedContent} onChange={(e) => setCommercial({ brandedContent: e.target.checked })} />
              Branded content (you&apos;re promoting someone else in exchange for something)
            </label>
            {commercialIncomplete && <p className="text-xs text-amber-300">Pick at least one.</p>}
            {label && <p className="text-xs text-zinc-400">{label}</p>}
          </div>
        )}
      </fieldset>

      {!aiAuto && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.markAsAi} onChange={(e) => set("markAsAi", e.target.checked)} />
          Label this as AI-generated
        </label>
      )}

      <fieldset className={box}>
        <legend className="px-1 text-sm text-zinc-300">How to post</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name={`mode-${post.id}`} checked={d.postMode === "direct"} onChange={() => set("postMode", "direct")} />
          Post directly at the scheduled time
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name={`mode-${post.id}`} checked={d.postMode === "drafts"} onChange={() => set("postMode", "drafts")} />
          Send to my TikTok drafts (you finish it in the TikTok app)
        </label>
      </fieldset>

      {post.madeForKids === null && (
        <fieldset className={box}>
          <legend className="px-1 text-sm text-zinc-300">Is this project made for kids?</legend>
          <p className="text-xs text-zinc-500">We ask once per project.</p>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={`kids-${post.id}`} checked={madeForKids === true} onChange={() => setMadeForKids(true)} />
              Yes
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={`kids-${post.id}`} checked={madeForKids === false} onChange={() => setMadeForKids(false)} />
              No
            </label>
          </div>
        </fieldset>
      )}

      <p className="text-xs text-zinc-400">{consent}</p>
      {localProblems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-300">
          {localProblems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {issues.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-red-300">
          {issues.map((i) => (
            <li key={i.code}>{i.message}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !local.success || blockedByAccount}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save TikTok settings"}
        </button>
        {saved && <span className="text-xs text-zinc-400">{saved}</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
