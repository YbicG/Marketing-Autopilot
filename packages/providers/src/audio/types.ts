import type { PaidOp, ProviderMeta } from "../core/types.ts";

/** §7.2 draft→final ladder: Flash for drafts and previews, v3 for finals. */
export type TtsQuality = "draft" | "final";

export interface TtsRequest {
  text: string;
  voiceId: string;
  quality: TtsQuality;
  /** mp3 (default, CBR 128k so the duration is exact from the byte count) or wav 48 kHz. */
  format?: "mp3" | "wav";
}

export interface AudioFile {
  bytes: Uint8Array;
  mime: "audio/mpeg" | "audio/wav";
  ext: "mp3" | "wav";
  durationMs: number;
}

export interface TtsResult extends AudioFile {
  /** The ElevenLabs model id that voiced this line. */
  model: string;
  characters: number;
}

export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface AlignRequest {
  audio: Uint8Array;
  mime: string;
  text: string;
  /** For the estimate only (alignment is billed by audio length). */
  durationMs: number;
}

export interface AlignResult {
  words: TimedWord[];
  /** Average alignment loss for the whole transcript (lower is better). */
  loss: number | null;
}

export interface SttRequest {
  audio: Uint8Array;
  mime: string;
  durationMs: number;
  languageCode?: string;
}

export interface SttResult {
  text: string;
  words: TimedWord[];
  languageCode: string | null;
}

/** What we keep so a track's commercial use can be shown later (§5.6 step 5: license receipt stored). */
export interface LicenseReceipt {
  provider: string;
  kind: "music" | "sfx" | "bundled";
  /** ElevenLabs song-id header (music) or request id. */
  ref: string | null;
  prompt: string;
  generatedAt: string;
  /** Plan the account was on when it was generated; ElevenLabs commercial rights depend on a paid plan. */
  terms: string;
}

export interface MusicRequest {
  /** Mood + tempo in plain words, e.g. "upbeat lo-fi, 100 bpm, no vocals". */
  prompt: string;
  /** Exact length (3 000–600 000 ms). */
  lengthMs: number;
}

export interface MusicResult extends AudioFile {
  license: LicenseReceipt;
}

export interface SfxRequest {
  text: string;
  /** 0.5–30 s. */
  durationSeconds: number;
}

export interface SfxResult extends AudioFile {
  license: LicenseReceipt;
}

/** §6 TTS / align / STT / music / SFX row. Every method is a PaidOp so core wraps it in runPaidCall. */
export interface AudioProvider {
  meta: ProviderMeta;
  tts: PaidOp<TtsRequest, TtsResult>;
  align: PaidOp<AlignRequest, AlignResult>;
  stt: PaidOp<SttRequest, SttResult>;
  music: PaidOp<MusicRequest, MusicResult>;
  sfx: PaidOp<SfxRequest, SfxResult>;
}

/** No ElevenLabs key: the caller shows the fallback (captions-only cut, bundled track, WER skipped). */
export class AudioKeyMissing extends Error {
  readonly code = "audio_key_missing";
  constructor() {
    super("No voice service key yet. Add an ElevenLabs key in Settings → Keys to add a voice.");
    this.name = "AudioKeyMissing";
  }
}

export class AudioProviderError extends Error {
  readonly code = "audio_provider_error";
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AudioProviderError";
  }
}
