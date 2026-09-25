// Test doubles for the video pipeline (core's own tests only; not exported from ./index.ts).
import { writeFile } from "node:fs/promises";
import { eq as eqId } from "drizzle-orm";
import type { ProbeInfo, SpecIssue, VideoScriptModel, VideoSpec, VideoSpecModel } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import type { Storage } from "../media/storage.ts";
import type { AudioOps } from "./deps.ts";
import type { Renderer, SpecTools, TimelineLike } from "./renderer.ts";

export function memoryStorage(initial: Record<string, Uint8Array> = {}): Storage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>(Object.entries(initial));
  return {
    objects,
    async put(key, body) {
      objects.set(key, new Uint8Array(body));
    },
    async get(key) {
      const b = objects.get(key);
      if (!b) throw new Error(`missing ${key}`);
      return Buffer.from(b);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const MS_PER_WORD = 400;
const wordsOf = (t: string) => t.trim().split(/\s+/).filter(Boolean);

/** Mirrors providers' fakeAudioProvider (not reachable from core until @mkt/providers re-exports audio). */
export function fakeAudio(opts: { hear?: (text: string, take: number) => string } = {}): AudioOps & {
  calls: { tts: { text: string; quality: string }[]; align: number; stt: number; music: number };
} {
  const calls = { tts: [] as { text: string; quality: string }[], align: 0, stt: 0, music: 0 };
  const takes = new Map<string, number>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const license = { provider: "fake", kind: "music", ref: "song-1", prompt: "p", generatedAt: "2026-01-01T00:00:00Z", terms: "test" };
  const timed = (t: string) => wordsOf(t).map((w, i) => ({ text: w, startMs: i * MS_PER_WORD, endMs: (i + 1) * MS_PER_WORD - 50 }));
  return {
    calls,
    meta: { id: "fake-audio" },
    tts: {
      estimate: (r) => r.text.length * 110,
      async execute(req) {
        calls.tts.push({ text: req.text, quality: req.quality });
        const take = (takes.get(req.text) ?? 0) + 1;
        takes.set(req.text, take);
        const durationMs = Math.max(MS_PER_WORD, wordsOf(req.text).length * MS_PER_WORD);
        return {
          result: { bytes: enc.encode(`FAKEAUDIO:${take}:${req.text}`), mime: "audio/mpeg", ext: "mp3", durationMs, model: req.quality, characters: req.text.length },
          usage: { actualMicros: req.text.length * 110 },
        };
      },
    },
    align: {
      estimate: () => 100,
      async execute(req) {
        calls.align++;
        return { result: { words: timed(req.text), loss: 0.1 }, usage: { actualMicros: 100 } };
      },
    },
    stt: {
      estimate: () => 100,
      async execute(req) {
        calls.stt++;
        const m = /^FAKEAUDIO:(\d+):([\s\S]*)$/.exec(dec.decode(req.audio));
        const voiced = m ? m[2]! : "";
        const heard = opts.hear ? opts.hear(voiced, Number(m?.[1] ?? 1)) : voiced;
        return { result: { text: heard, words: timed(heard), languageCode: "en" }, usage: { actualMicros: 100 } };
      },
    },
    music: {
      estimate: () => 1000,
      async execute(req) {
        calls.music++;
        return { result: { bytes: enc.encode(`FAKEMUSIC:${req.prompt}:${req.lengthMs}`), mime: "audio/mpeg", ext: "mp3", durationMs: req.lengthMs, license }, usage: { actualMicros: 1000 } };
      },
    },
    sfx: {
      estimate: () => 100,
      async execute() {
        return { result: { bytes: enc.encode("FAKESFX"), mime: "audio/mpeg", ext: "mp3", durationMs: 500, license: { ...license, kind: "sfx" } }, usage: { actualMicros: 100 } };
      },
    },
  };
}

/** VO_PAD like @mkt/video's resolveTimeline: each part lasts max(minMs, voice + 300 ms). */
export function fakeTools(lint: (spec: VideoSpec) => SpecIssue[] = () => []): SpecTools & { lintCalls: number } {
  const tools = {
    lintCalls: 0,
    resolveTimeline(spec: VideoSpec, vo: Record<string, number>, hookIdx: number): TimelineLike {
      const hookMs = Math.max(1500, (vo.hook ?? vo[`hook:${hookIdx}`] ?? 0) + 300);
      let t = hookMs;
      const scenes = spec.scenes.map((s) => {
        const durationMs = Math.max(s.minMs, (vo[s.id] ?? 0) + 300);
        const out = { id: s.id, startMs: t, durationMs };
        t += durationMs;
        return out;
      });
      const ctaMs = Math.max(2000, (vo.cta ?? 0) + 300);
      return { totalMs: t + ctaMs, hookMs, scenes, ctaStartMs: t, ctaMs };
    },
    lintSpec(spec: VideoSpec) {
      tools.lintCalls++;
      return lint(spec);
    },
    inSafeZone: () => true,
  };
  return tools;
}

export const goodProbe = (w = 1080, h = 1920): ProbeInfo => ({
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  durationMs: 30_000,
  sizeBytes: 5_000_000,
  bitRate: 1_300_000,
  faststart: true,
  video: { codec: "h264", profile: "High", width: w, height: h, pixFmt: "yuv420p", fps: 30, cfr: true, bitRate: 1_200_000, frames: 900 },
  audio: { codec: "aac", profile: "LC", sampleRate: 48_000, channels: 2, bitRate: 128_000 },
});

/** Writes small placeholder files so storeOutputs can read them back; nothing is rendered. */
export function fakeRenderer(opts: { lufs?: number[]; renderFails?: number } = {}): Renderer & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const hit = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  let n = 0;
  const lufs = [...(opts.lufs ?? [-14])];
  let fails = opts.renderFails ?? 0;
  const touch = (p: string, tag: string) => writeFile(p, `${tag}:${++n}`);
  return {
    calls,
    async renderVideo(o) {
      hit("renderVideo");
      if (fails-- > 0) throw new Error("chromium crashed");
      await touch(o.outPath, `video-${o.hookIdx}`);
      return { path: o.outPath, durationMs: o.props.timeline.totalMs };
    },
    async renderStillImage(o) {
      hit("renderStillImage");
      // Deterministic like a real render of the same props.
      await writeFile(o.outPath, `still:${o.props.width}x${o.props.height}:${o.props.template}:${o.props.slide.headline}`);
      return { path: o.outPath };
    },
    async ffprobe() {
      hit("ffprobe");
      return goodProbe();
    },
    async loudnormTwoPass(_i, out) {
      hit("loudnorm");
      await touch(out, "master");
    },
    async measureLoudness() {
      hit("measureLoudness");
      return { lufs: lufs.length > 1 ? lufs.shift()! : lufs[0]!, truePeak: -1.6 };
    },
    async transcodeVariants(_m, dir) {
      hit("transcode");
      const f = (k: string, ext = "mp4") => `${dir}/${k}.${ext}`;
      for (const k of ["tiktok", "ig_reel", "yt_short", "x"]) await touch(f(k), k);
      await touch(f("thumb", "webp"), "thumb");
      return { tiktok: f("tiktok"), ig_reel: f("ig_reel"), yt_short: f("yt_short"), x: f("x"), thumb: f("thumb", "webp") };
    },
    async contactSheet(_m, out) {
      hit("contactSheet");
      await touch(out, "sheet");
    },
    async extractFrame(_v, _at, out) {
      hit("extractFrame");
      await touch(out, "frame");
    },
    async writeXmp() {
      hit("writeXmp");
    },
    checkAgainstPlatform: () => [],
    async buildLinkedInPdf(paths) {
      hit("buildLinkedInPdf");
      return new TextEncoder().encode(`%PDF-fake ${paths.length}`);
    },
  };
}

// ── model replies ──

export function scriptReply(shotId: string, over: Partial<VideoScriptModel> = {}): VideoScriptModel {
  return {
    hooks: [
      { style: "pain_callout", onScreen: "Still typing deadlines?", vo: "Still typing every deadline by hand?" },
      { style: "speed_demo", onScreen: "15 seconds. Whole semester.", vo: "Watch a whole semester land in fifteen seconds." },
      { style: "pov", onScreen: "POV: 5 syllabi", vo: "POV: you just got five syllabi." },
    ],
    beats: [
      { vo: "Drop your syllabus PDF in.", onScreen: "Drop the PDF", assetRefs: [shotId] },
      { vo: "Every deadline shows up in your calendar.", onScreen: null, assetRefs: [shotId] },
    ],
    cta: { onScreen: "Link in bio", vo: "Try it free, link in bio." },
    claimRefs: ["C1", "C2"],
    assetRefs: [shotId, "not-a-real-asset"],
    ...over,
  };
}

export function specReply(shotId: string, script: Pick<VideoScriptModel, "hooks" | "cta">): VideoSpecModel {
  const visual = { kind: "screenshot" as const, assetId: shotId, trim: null, focusBox: null, device: null };
  const scene = (id: string, vo: string) => ({ id, type: "ScreenshotKenBurns" as const, vo, overlay: null, minMs: 2000, visual, camera: null, claimRefs: null, copy: null, compare: null });
  return {
    format: "9x16",
    targetSeconds: 30,
    voice: { voiceId: "v1", model: "draft" },
    music: { mood: "upbeat lo-fi", duckDb: -12 },
    captions: { enabled: true, style: "tiktok" },
    hookVariants: script.hooks,
    scenes: [scene("s1", "Drop your syllabus PDF in."), scene("s2", "Every deadline shows up in your calendar.")],
    transitions: [],
    sfx: [],
    cta: script.cta,
    disclosures: [],
  };
}

// ── a seeded workspace with one video item ──

export interface VideoWorld {
  ws: string;
  productId: string;
  campaignId: string;
  runId: string;
  itemId: string;
  shotId: string;
  shotKey: string;
  userId: string;
}

export async function seedVideoWorld(db: Db, opts: { targets?: string[] } = {}): Promise<VideoWorld> {
  const ws = uuidv7();
  const productId = uuidv7();
  const dnaId = uuidv7();
  const strategyId = uuidv7();
  const campaignId = uuidv7();
  const runId = uuidv7();
  const itemId = uuidv7();
  const shotId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t", timezone: "UTC" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: `p-${productId.slice(-6)}`, name: "SyllaCal", kind: "web_b2c" });
  await db.insert(schema.productDnaVersions).values({ id: dnaId, workspaceId: ws, productId, version: 1, status: "confirmed", dna: {}, fields: {}, sourceMap: {} });
  await db.update(schema.products).set({ currentDnaVersionId: dnaId }).where(eqId(schema.products.id, productId));
  await db.insert(schema.claims).values([
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C1", kind: "feature", text: "Syllabus to calendar in about 15 seconds", sourceRefs: ["S1"], publicOk: true },
    { id: uuidv7(), workspaceId: ws, productId, dnaVersionId: dnaId, ref: "C2", kind: "stat", text: "94% accuracy (internal)", sourceRefs: ["S5"], publicOk: false },
  ]);
  await db.insert(schema.strategies).values({ id: strategyId, workspaceId: ws, productId, dnaVersionId: dnaId, output: {}, launchDate: "2026-10-20" });
  await db.insert(schema.generationRuns).values({ id: runId, workspaceId: ws, productId, kind: "package", status: "running", input: {}, capMicros: 50_000_000 });
  await db.insert(schema.campaigns).values({ id: campaignId, workspaceId: ws, productId, strategyId, runId, tier: "standard", startDate: "2026-10-01", launchDate: "2026-10-14", platforms: ["tiktok", "instagram", "youtube"] });
  const targets = opts.targets ?? ["tiktok", "instagram", "youtube"];
  await db.insert(schema.contentItems).values({
    id: itemId,
    workspaceId: ws,
    campaignId,
    runId,
    deliverableKey: "video:master-01",
    kind: "video",
    brief: { schemaVersion: 1, targets: targets.map((platform) => ({ platform, format: "video" })) },
  });
  await db.insert(schema.assets).values({
    id: shotId,
    workspaceId: ws,
    productId,
    kind: "screenshot",
    origin: "captured",
    mime: "image/png",
    sha256: `sha-${shotId}`,
    storageKey: `ws/${ws}/assets/shot.png`,
    width: 1280,
    height: 800,
    labels: { caption: "Upload screen", hasPersonalData: false },
  });
  return { ws, productId, campaignId, runId, itemId, shotId, shotKey: `ws/${ws}/assets/shot.png`, userId: "user-1" };
}

