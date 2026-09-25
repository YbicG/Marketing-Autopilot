import { ALIGN_MICROS_PER_SECOND, MUSIC_MICROS_PER_SECOND, STT_MICROS_PER_SECOND, secondsMicros, sfxMicros, ttsMicros } from "./rates.ts";
import type { AudioProvider, SttRequest, TimedWord, TtsRequest } from "./types.ts";

/** 400 ms per word: close enough to real speech (2.5 words/s) for timeline tests. */
export const FAKE_MS_PER_WORD = 400;

export interface FakeAudioOptions {
  /** What Scribe "hears" for a line (default: the text exactly). Called with the text that was voiced. */
  hear?: (voicedText: string, take: number) => string;
}

export interface FakeAudioCalls {
  tts: TtsRequest[];
  align: string[];
  stt: SttRequest[];
  music: number;
  sfx: number;
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean);

function timed(text: string): TimedWord[] {
  return words(text).map((w, i) => ({ text: w, startMs: i * FAKE_MS_PER_WORD, endMs: (i + 1) * FAKE_MS_PER_WORD - 50 }));
}

/**
 * Deterministic audio provider for tests and PROVIDER_MODE=fake. The "audio" bytes are the text
 * itself (prefixed), so STT can recover what was voiced without decoding anything.
 */
export function fakeAudioProvider(opts: FakeAudioOptions = {}): AudioProvider & { calls: FakeAudioCalls } {
  const calls: FakeAudioCalls = { tts: [], align: [], stt: [], music: 0, sfx: 0 };
  const takes = new Map<string, number>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PREFIX = "FAKEAUDIO:";

  return {
    calls,
    meta: { id: "fake-audio", kind: "tts", requiredSecrets: [] },
    tts: {
      estimate: (r) => ttsMicros(r.text.length, r.quality),
      async execute(req) {
        calls.tts.push(req);
        const take = (takes.get(req.text) ?? 0) + 1;
        takes.set(req.text, take);
        const bytes = enc.encode(`${PREFIX}${take}:${req.text}`);
        const durationMs = Math.max(FAKE_MS_PER_WORD, words(req.text).length * FAKE_MS_PER_WORD);
        const model = req.quality === "final" ? "fake_v3" : "fake_flash";
        return {
          result: { bytes, mime: "audio/mpeg", ext: "mp3", durationMs, model, characters: req.text.length },
          usage: { actualMicros: ttsMicros(req.text.length, req.quality) },
          servedModel: model,
        };
      },
    },
    align: {
      estimate: (r) => secondsMicros(r.durationMs, ALIGN_MICROS_PER_SECOND),
      async execute(req) {
        calls.align.push(req.text);
        return { result: { words: timed(req.text), loss: 0.1 }, usage: { actualMicros: secondsMicros(req.durationMs, ALIGN_MICROS_PER_SECOND) } };
      },
    },
    stt: {
      estimate: (r) => secondsMicros(r.durationMs, STT_MICROS_PER_SECOND),
      async execute(req) {
        calls.stt.push(req);
        const raw = dec.decode(req.audio);
        const m = raw.startsWith(PREFIX) ? /^FAKEAUDIO:(\d+):([\s\S]*)$/.exec(raw) : null;
        const voiced = m ? m[2]! : raw;
        const take = m ? Number(m[1]) : 1;
        const heard = opts.hear ? opts.hear(voiced, take) : voiced;
        return { result: { text: heard, words: timed(heard), languageCode: "en" }, usage: { actualMicros: secondsMicros(req.durationMs, STT_MICROS_PER_SECOND) } };
      },
    },
    music: {
      estimate: (r) => secondsMicros(r.lengthMs, MUSIC_MICROS_PER_SECOND),
      async execute(req) {
        calls.music++;
        return {
          result: {
            bytes: enc.encode(`${PREFIX}music:${req.prompt}`),
            mime: "audio/mpeg",
            ext: "mp3",
            durationMs: req.lengthMs,
            license: { provider: "fake", kind: "music", ref: `song_${calls.music}`, prompt: req.prompt, generatedAt: "2026-01-01T00:00:00.000Z", terms: "fake" },
          },
          usage: { actualMicros: secondsMicros(req.lengthMs, MUSIC_MICROS_PER_SECOND) },
        };
      },
    },
    sfx: {
      estimate: (r) => sfxMicros(r.durationSeconds),
      async execute(req) {
        calls.sfx++;
        return {
          result: {
            bytes: enc.encode(`${PREFIX}sfx:${req.text}`),
            mime: "audio/mpeg",
            ext: "mp3",
            durationMs: Math.round(req.durationSeconds * 1000),
            license: { provider: "fake", kind: "sfx", ref: `sfx_${calls.sfx}`, prompt: req.text, generatedAt: "2026-01-01T00:00:00.000Z", terms: "fake" },
          },
          usage: { actualMicros: sfxMicros(req.durationSeconds) },
        };
      },
    },
  };
}
