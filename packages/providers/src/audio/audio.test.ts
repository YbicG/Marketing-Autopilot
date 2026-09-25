import { describe, expect, it } from "vitest";
import { createElevenLabsAudio, deadlineFetch, mp3CbrDurationMs, wavDurationMs } from "./elevenlabs.ts";
import { fakeAudioProvider } from "./fake.ts";
import { ttsMicros } from "./rates.ts";
import { AudioKeyMissing, AudioProviderError } from "./types.ts";

const ctx = (key: string | null = "xi_test") => ({ secret: async () => key });

function recorder(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  return {
    seen,
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return respond(url, init);
    },
  };
}

describe("elevenlabs", () => {
  it("voices a draft line on Flash with the key header and a CBR duration", async () => {
    const r = recorder(() => new Response(new Uint8Array(16_000), { headers: { "request-id": "req_1" } }));
    const el = createElevenLabsAudio({ fetch: r.fetch });
    const out = await el.tts.execute({ text: "Hello there", voiceId: "v 1", quality: "draft" }, ctx());
    expect(r.seen[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/v%201?output_format=mp3_44100_128");
    expect((r.seen[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("xi_test");
    expect(JSON.parse(String(r.seen[0]!.init.body))).toEqual({ text: "Hello there", model_id: "eleven_flash_v2_5" });
    expect(out.result.durationMs).toBe(1000);
    expect(out.servedModel).toBe("eleven_flash_v2_5");
    expect(out.providerRequestId).toBe("req_1");
    expect(out.usage.actualMicros).toBe(ttsMicros(11, "draft"));
  });

  it("uses v3 for finals and bills finals at the full rate", async () => {
    const r = recorder(() => new Response(new Uint8Array(1600)));
    const el = createElevenLabsAudio({ fetch: r.fetch });
    const out = await el.tts.execute({ text: "x".repeat(100), voiceId: "v", quality: "final" }, ctx());
    expect(JSON.parse(String(r.seen[0]!.init.body)).model_id).toBe("eleven_v3");
    expect(el.tts.estimate({ text: "x".repeat(100), voiceId: "v", quality: "final" })).toBe(2 * el.tts.estimate({ text: "x".repeat(100), voiceId: "v", quality: "draft" }));
    expect(out.usage.actualMicros).toBeGreaterThan(0);
  });

  it("throws AudioKeyMissing without a key and never calls out", async () => {
    const r = recorder(() => new Response(""));
    const el = createElevenLabsAudio({ fetch: r.fetch });
    await expect(el.tts.execute({ text: "a", voiceId: "v", quality: "draft" }, ctx(null))).rejects.toBeInstanceOf(AudioKeyMissing);
    expect(r.seen).toHaveLength(0);
  });

  it("maps HTTP errors to plain messages", async () => {
    const el = createElevenLabsAudio({ fetch: async () => new Response(JSON.stringify({ detail: { status: "quota_exceeded" } }), { status: 401 }) });
    await expect(el.tts.execute({ text: "a", voiceId: "v", quality: "draft" }, ctx())).rejects.toThrow(/didn't accept the key/);
    const busy = createElevenLabsAudio({ fetch: async () => new Response("", { status: 429 }) });
    const err = await busy.tts.execute({ text: "a", voiceId: "v", quality: "draft" }, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudioProviderError);
    expect((err as AudioProviderError).retryable).toBe(true);
  });

  it("aborts at the deadline, and on a caller abort", async () => {
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(deadlineFetch(hang, "https://x.test", {}, 20)).rejects.toThrow(/took too long/);
    const ac = new AbortController();
    const el = createElevenLabsAudio({ fetch: hang });
    const p = el.sfx.execute({ text: "whoosh", durationSeconds: 1 }, { ...ctx(), signal: ac.signal });
    ac.abort(new Error("caller"));
    await expect(p).rejects.toThrow("caller");
  });

  it("parses forced alignment words in ms", async () => {
    const r = recorder(() => new Response(JSON.stringify({ words: [{ text: "Hi", start: 0.1, end: 0.35, loss: 0.2 }, { text: " ", start: 0.35, end: 0.4 }], loss: 0.2 })));
    const el = createElevenLabsAudio({ fetch: r.fetch });
    const out = await el.align.execute({ audio: new Uint8Array([1]), mime: "audio/mpeg", text: "Hi", durationMs: 500 }, ctx());
    expect(r.seen[0]!.url).toBe("https://api.elevenlabs.io/v1/forced-alignment");
    expect(r.seen[0]!.init.body).toBeInstanceOf(FormData);
    expect(out.result.words).toEqual([{ text: "Hi", startMs: 100, endMs: 350 }]);
  });

  it("asks Music for an instrumental of the exact length and keeps the song id", async () => {
    const r = recorder(() => new Response(new Uint8Array(16_000 * 30), { headers: { "song-id": "song_9" } }));
    const el = createElevenLabsAudio({ fetch: r.fetch, now: () => new Date("2026-11-10T00:00:00Z") });
    const out = await el.music.execute({ prompt: "calm lo-fi", lengthMs: 30_000 }, ctx());
    const body = JSON.parse(String(r.seen[0]!.init.body));
    expect(body).toMatchObject({ music_length_ms: 30_000, force_instrumental: true });
    expect(out.result.license).toMatchObject({ kind: "music", ref: "song_9", generatedAt: "2026-11-10T00:00:00.000Z" });
  });
});

describe("durations", () => {
  it("skips an ID3 tag", () => {
    const b = new Uint8Array(10 + 5 + 16_000);
    b.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5]);
    expect(mp3CbrDurationMs(b, 128_000)).toBe(1000);
  });
  it("reads a wav header", () => {
    const data = 48_000 * 2; // 1 s mono 16-bit 48 kHz
    const b = new Uint8Array(44 + data);
    const dv = new DataView(b.buffer);
    const put = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
    put(0, "RIFF");
    put(8, "WAVE");
    put(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint32(28, 96_000, true);
    put(36, "data");
    dv.setUint32(40, data, true);
    expect(wavDurationMs(b)).toBe(1000);
  });
});

describe("fake audio", () => {
  it("round-trips voiced text through STT and counts takes", async () => {
    const fake = fakeAudioProvider({ hear: (t, take) => (take === 1 ? "wrong words" : t) });
    const a = await fake.tts.execute({ text: "one two", voiceId: "v", quality: "final" }, ctx());
    const s1 = await fake.stt.execute({ audio: a.result.bytes, mime: "audio/mpeg", durationMs: 800 }, ctx());
    expect(s1.result.text).toBe("wrong words");
    const b = await fake.tts.execute({ text: "one two", voiceId: "v", quality: "final" }, ctx());
    const s2 = await fake.stt.execute({ audio: b.result.bytes, mime: "audio/mpeg", durationMs: 800 }, ctx());
    expect(s2.result.text).toBe("one two");
  });
});
