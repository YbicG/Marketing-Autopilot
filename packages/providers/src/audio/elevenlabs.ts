import type { ProviderCtx } from "../core/types.ts";
import {
  ALIGN_MICROS_PER_SECOND,
  ELEVENLABS_PLAN,
  MUSIC_MICROS_PER_SECOND,
  STT_MICROS_PER_SECOND,
  secondsMicros,
  sfxMicros,
  ttsMicros,
} from "./rates.ts";
import {
  AudioKeyMissing,
  AudioProviderError,
  type AlignRequest,
  type AlignResult,
  type AudioFile,
  type AudioProvider,
  type MusicRequest,
  type MusicResult,
  type SfxRequest,
  type SfxResult,
  type SttRequest,
  type SttResult,
  type TimedWord,
  type TtsRequest,
  type TtsResult,
} from "./types.ts";

/**
 * ElevenLabs over plain HTTPS (no SDK). Endpoints checked against elevenlabs.io/docs on 2026-09-25:
 * - POST /v1/text-to-speech/{voice_id}?output_format=…  body { text, model_id }  → audio bytes
 * - POST /v1/forced-alignment  multipart { file, text }  → { words[{text,start,end,loss}], loss } (seconds)
 * - POST /v1/speech-to-text    multipart { model_id, file, timestamps_granularity } → { text, words[] }
 * - POST /v1/music?output_format=…  body { prompt, music_length_ms, model_id, force_instrumental } → audio, `song-id` header
 * - POST /v1/sound-generation?output_format=…  body { text, duration_seconds, model_id } → audio
 * Auth header: xi-api-key.
 * Unconfirmed: the exact model ids below (Flash v2.5 / v3 / scribe_v2 / music_v1 / sfx v2) are the
 * current documented names, and the `request-id` response header name.
 */
export const ELEVENLABS_MODELS = {
  ttsDraft: "eleven_flash_v2_5",
  ttsFinal: "eleven_v3",
  stt: "scribe_v2",
  music: "music_v1",
  sfx: "eleven_text_to_sound_v2",
} as const;

export const ELEVENLABS_SECRET = "elevenlabs.api_key";
const BASE = "https://api.elevenlabs.io";

/** §5.0: long TTS and music get 180 s; everything else 60–120 s. */
export const TIMEOUTS = { longTts: 180_000, shortTts: 60_000, music: 180_000, align: 120_000, stt: 120_000, sfx: 60_000 } as const;
const LONG_TTS_CHARS = 800;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ElevenLabsOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => Date;
}

export function createElevenLabsAudio(opts: ElevenLabsOptions = {}): AudioProvider {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const base = opts.baseUrl ?? BASE;
  const now = opts.now ?? (() => new Date());

  async function key(ctx: ProviderCtx): Promise<string> {
    const k = await ctx.secret(ELEVENLABS_SECRET);
    if (!k) throw new AudioKeyMissing();
    return k;
  }

  async function call(ctx: ProviderCtx, path: string, init: RequestInit, timeoutMs: number) {
    const res = await deadlineFetch(doFetch, `${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), "xi-api-key": await key(ctx) } }, timeoutMs, ctx.signal);
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.body);
    return res;
  }

  return {
    meta: {
      id: "elevenlabs",
      kind: "tts",
      requiredSecrets: [ELEVENLABS_SECRET],
      models: Object.values(ELEVENLABS_MODELS).map((id) => ({ id })),
      pricingKeys: ["elevenlabs.tts", "elevenlabs.align", "elevenlabs.stt", "elevenlabs.music", "elevenlabs.sfx"],
    },

    tts: {
      estimate: (req) => ttsMicros(req.text.length, req.quality),
      async execute(req: TtsRequest, ctx) {
        const model = req.quality === "final" ? ELEVENLABS_MODELS.ttsFinal : ELEVENLABS_MODELS.ttsDraft;
        const format = req.format ?? "mp3";
        const res = await call(
          ctx,
          `/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=${format === "wav" ? "wav_48000" : "mp3_44100_128"}`,
          { method: "POST", headers: { "content-type": "application/json", accept: format === "wav" ? "audio/wav" : "audio/mpeg" }, body: JSON.stringify({ text: req.text, model_id: model }) },
          req.text.length > LONG_TTS_CHARS ? TIMEOUTS.longTts : TIMEOUTS.shortTts,
        );
        const file = audioFile(res.body, format);
        const result: TtsResult = { ...file, model, characters: req.text.length };
        return { result, usage: { actualMicros: ttsMicros(req.text.length, req.quality), units: { characters: req.text.length } }, providerRequestId: res.requestId, servedModel: model };
      },
    },

    align: {
      estimate: (req) => secondsMicros(req.durationMs, ALIGN_MICROS_PER_SECOND),
      async execute(req: AlignRequest, ctx) {
        const form = new FormData();
        form.set("file", new Blob([req.audio as Uint8Array<ArrayBuffer>], { type: req.mime }), `audio.${extFor(req.mime)}`);
        form.set("text", req.text);
        const res = await call(ctx, "/v1/forced-alignment", { method: "POST", body: form }, TIMEOUTS.align);
        const json = parseJson(res.body) as { words?: { text?: string; start?: number; end?: number }[]; loss?: number };
        const result: AlignResult = { words: toWords(json.words), loss: typeof json.loss === "number" ? json.loss : null };
        return { result, usage: { actualMicros: secondsMicros(req.durationMs, ALIGN_MICROS_PER_SECOND), units: { seconds: req.durationMs / 1000 } }, providerRequestId: res.requestId };
      },
    },

    stt: {
      estimate: (req) => secondsMicros(req.durationMs, STT_MICROS_PER_SECOND),
      async execute(req: SttRequest, ctx) {
        const form = new FormData();
        form.set("model_id", ELEVENLABS_MODELS.stt);
        form.set("file", new Blob([req.audio as Uint8Array<ArrayBuffer>], { type: req.mime }), `audio.${extFor(req.mime)}`);
        form.set("timestamps_granularity", "word");
        form.set("tag_audio_events", "false");
        if (req.languageCode) form.set("language_code", req.languageCode);
        const res = await call(ctx, "/v1/speech-to-text", { method: "POST", body: form }, TIMEOUTS.stt);
        const json = parseJson(res.body) as { text?: string; language_code?: string; words?: { text?: string; start?: number; end?: number; type?: string }[] };
        const result: SttResult = {
          text: String(json.text ?? ""),
          words: toWords((json.words ?? []).filter((w) => !w.type || w.type === "word")),
          languageCode: json.language_code ?? null,
        };
        return { result, usage: { actualMicros: secondsMicros(req.durationMs, STT_MICROS_PER_SECOND), units: { seconds: req.durationMs / 1000 } }, providerRequestId: res.requestId, servedModel: ELEVENLABS_MODELS.stt };
      },
    },

    music: {
      estimate: (req) => secondsMicros(req.lengthMs, MUSIC_MICROS_PER_SECOND),
      async execute(req: MusicRequest, ctx) {
        const lengthMs = Math.min(600_000, Math.max(3_000, Math.round(req.lengthMs)));
        const res = await call(
          ctx,
          "/v1/music?output_format=mp3_44100_128",
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "audio/mpeg" },
            body: JSON.stringify({ prompt: req.prompt, music_length_ms: lengthMs, model_id: ELEVENLABS_MODELS.music, force_instrumental: true }),
          },
          TIMEOUTS.music,
        );
        const file = audioFile(res.body, "mp3");
        const result: MusicResult = {
          ...file,
          license: { provider: "elevenlabs", kind: "music", ref: res.headers.get("song-id") ?? res.requestId ?? null, prompt: req.prompt, generatedAt: now().toISOString(), terms: `elevenlabs:${ELEVENLABS_PLAN}` },
        };
        return { result, usage: { actualMicros: secondsMicros(lengthMs, MUSIC_MICROS_PER_SECOND), units: { seconds: lengthMs / 1000 } }, providerRequestId: res.requestId, servedModel: ELEVENLABS_MODELS.music };
      },
    },

    sfx: {
      estimate: (req) => sfxMicros(clampSfx(req.durationSeconds)),
      async execute(req: SfxRequest, ctx) {
        const seconds = clampSfx(req.durationSeconds);
        const res = await call(
          ctx,
          "/v1/sound-generation?output_format=mp3_44100_128",
          { method: "POST", headers: { "content-type": "application/json", accept: "audio/mpeg" }, body: JSON.stringify({ text: req.text, duration_seconds: seconds, model_id: ELEVENLABS_MODELS.sfx }) },
          TIMEOUTS.sfx,
        );
        const file = audioFile(res.body, "mp3");
        const result: SfxResult = {
          ...file,
          license: { provider: "elevenlabs", kind: "sfx", ref: res.requestId ?? null, prompt: req.text, generatedAt: now().toISOString(), terms: `elevenlabs:${ELEVENLABS_PLAN}` },
        };
        return { result, usage: { actualMicros: sfxMicros(seconds), units: { seconds } }, providerRequestId: res.requestId, servedModel: ELEVENLABS_MODELS.sfx };
      },
    },
  };
}

const clampSfx = (s: number) => Math.min(30, Math.max(0.5, s));

interface FetchedBody {
  status: number;
  body: Uint8Array;
  headers: Headers;
  requestId: string | undefined;
}

/**
 * Manual AbortController deadline (§5.0: AbortSignal.timeout() + fetch is unreliable on
 * Node 24/Windows). The deadline covers reading the body too.
 */
export async function deadlineFetch(doFetch: FetchLike, url: string, init: RequestInit, timeoutMs: number, callerSignal?: AbortSignal): Promise<FetchedBody> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort(callerSignal?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new Error("deadline"));
  }, timeoutMs);
  timer.unref?.();
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    if (ctrl.signal.aborted) throw ctrl.signal.reason ?? new Error("aborted");
    const res = await doFetch(url, { ...init, signal: ctrl.signal });
    const body = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers, requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id") ?? undefined };
  } catch (err) {
    if (timedOut) throw new AudioProviderError("The voice service took too long to answer. Try again in a moment.", null, true);
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

function httpError(status: number, body: Uint8Array): AudioProviderError {
  let detail = "";
  try {
    const j = JSON.parse(new TextDecoder().decode(body)) as { detail?: { message?: string; status?: string } | string };
    detail = typeof j.detail === "string" ? j.detail : (j.detail?.status ?? j.detail?.message ?? "");
  } catch {
    // not JSON
  }
  if (status === 401) return new AudioProviderError("ElevenLabs didn't accept the key. Check it in Settings → Keys.", status, false);
  if (status === 402 || /quota|credits/i.test(detail)) return new AudioProviderError("Your ElevenLabs plan is out of credits this month.", status, false);
  if (status === 422 || status === 400) return new AudioProviderError(`ElevenLabs rejected the request${detail ? ` (${detail.slice(0, 120)})` : ""}.`, status, false);
  if (status === 429) return new AudioProviderError("ElevenLabs is busy. Try again in a minute.", status, true);
  return new AudioProviderError(`ElevenLabs answered ${status}. Try again in a minute.`, status, status >= 500);
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new AudioProviderError("ElevenLabs sent back something we couldn't read.", null, true);
  }
}

function toWords(ws: { text?: string; start?: number; end?: number }[] | undefined): TimedWord[] {
  return (ws ?? [])
    .filter((w) => typeof w.start === "number" && typeof w.end === "number" && String(w.text ?? "").trim())
    .map((w) => ({ text: String(w.text).trim(), startMs: Math.round(w.start! * 1000), endMs: Math.round(w.end! * 1000) }));
}

function extFor(mime: string): string {
  return mime.includes("wav") ? "wav" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : "mp3";
}

export function audioFile(bytes: Uint8Array, format: "mp3" | "wav"): AudioFile {
  if (bytes.byteLength === 0) throw new AudioProviderError("ElevenLabs sent back an empty file.", null, true);
  return format === "wav"
    ? { bytes, mime: "audio/wav", ext: "wav", durationMs: wavDurationMs(bytes) }
    : { bytes, mime: "audio/mpeg", ext: "mp3", durationMs: mp3CbrDurationMs(bytes, 128_000) };
}

/** mp3_44100_128 is constant bitrate, so length = bytes × 8 / bitrate (an ID3 tag, if any, is skipped). */
export function mp3CbrDurationMs(bytes: Uint8Array, bitrate: number): number {
  let audioBytes = bytes.byteLength;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.byteLength > 10) {
    const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    audioBytes -= size + 10;
  }
  return Math.max(0, Math.round((audioBytes * 8 * 1000) / bitrate));
}

/** Reads the RIFF header: data chunk size ÷ byte rate. */
export function wavDurationMs(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new AudioProviderError("That isn't a WAV file.", null, false);
  let byteRate = 0;
  let o = 12;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === "fmt ") byteRate = dv.getUint32(o + 16, true);
    if (id === "data") {
      if (!byteRate) break;
      // Streamed WAVs may carry 0xFFFFFFFF as the size: use what's actually there.
      const dataSize = Math.min(size, bytes.byteLength - o - 8);
      return Math.round((dataSize * 1000) / byteRate);
    }
    o += 8 + size + (size % 2);
  }
  throw new AudioProviderError("That WAV file has no audio data.", null, false);
}
