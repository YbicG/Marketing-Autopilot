import type Anthropic from "@anthropic-ai/sdk";
import type { RunEvent } from "@mkt/contracts";
import type { Db } from "@mkt/db";
import type { PaidOp, ProviderCtx } from "@mkt/providers";
import type { RateLookup } from "../ai/usage.ts";
import type { Storage } from "../media/storage.ts";
import type { ImageDecoder, ImageResizer, Renderer, SpecTools } from "./renderer.ts";

/**
 * Structurally the AudioProvider of packages/providers/src/audio (ElevenLabs or the fake). Declared
 * here because @mkt/providers' root entry doesn't re-export the audio module yet; once it does,
 * this can become `import type { AudioProvider } from "@mkt/providers"`.
 */
export interface TimedWordLike {
  text: string;
  startMs: number;
  endMs: number;
}
interface AudioFileLike {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  durationMs: number;
}
export interface LicenseLike {
  provider: string;
  kind: string;
  ref: string | null;
  prompt: string;
  generatedAt: string;
  terms: string;
}
export interface AudioOps {
  meta: { id: string };
  tts: PaidOp<{ text: string; voiceId: string; quality: "draft" | "final"; format?: "mp3" | "wav" }, AudioFileLike & { model: string; characters: number }>;
  align: PaidOp<{ audio: Uint8Array; mime: string; text: string; durationMs: number }, { words: TimedWordLike[]; loss: number | null }>;
  stt: PaidOp<{ audio: Uint8Array; mime: string; durationMs: number; languageCode?: string }, { text: string; words: TimedWordLike[]; languageCode: string | null }>;
  music: PaidOp<{ prompt: string; lengthMs: number }, AudioFileLike & { license: LicenseLike }>;
  sfx: PaidOp<{ text: string; durationSeconds: number }, AudioFileLike & { license: LicenseLike }>;
}

/** Everything the video pipeline touches. The worker builds one per job; tests pass fakes. */
export interface VideoDeps {
  db: Db;
  rates: RateLookup;
  storage: Storage;
  client?: Anthropic;
  /** null = no ElevenLabs key: the captions-only kinetic cut + bundled track (§6 "without a key"). */
  audio: AudioOps | null;
  /** Vault then env (D19); passed to every audio call. */
  providerCtx: ProviderCtx;
  renderer: Renderer;
  tools: SpecTools;
  publish?: (event: RunEvent) => Promise<unknown>;
  /** Owned by the publishing engine: voids every live approval (and drops its posts back to pending). */
  voidApprovalsFor(variantIds: string[], reason: string): Promise<void>;
  /** Queue a render.video job (render queue, jobId = renderId). */
  enqueueRender(renderId: string, opts?: { delayMs?: number }): Promise<void>;
  imageDecoder?: ImageDecoder;
  imageResizer?: ImageResizer;
  /** Local scratch dir for renders (worker: under the OS temp dir). */
  workDir?: string;
  /** REMOTION_CONCURRENCY. */
  concurrency?: number;
  /** Asset id of the bundled licensed track used when there is no key (or music failed twice). */
  bundledTrackAssetId?: string | null;
  /** Default ElevenLabs voice when the spec has none. */
  defaultVoiceId?: string;
  now?: () => Date;
}

export const nowOf = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());
