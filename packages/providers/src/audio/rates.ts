/**
 * ElevenLabs at the plan's effective rate (§7.1 step 8: quota plans are billed at their effective
 * rate, with budgets that only alert). Micro-dollars.
 *
 * TODO(M3a server check): confirm every number below on the Creator plan ($22/mo, 100k credits)
 * against the ElevenLabs pricing page and the usage dashboard after the first real package.
 * The credit costs per unit are from the public pricing notes as understood on 2026-09-25 and are
 * NOT confirmed.
 */
export const ELEVENLABS_PLAN = "creator";

/** $22 / 100 000 credits. */
export const MICROS_PER_CREDIT = 220;

/** Credits per character. Flash/Turbo are half price; v3 costs a full credit. (unconfirmed) */
export const TTS_CREDITS_PER_CHAR = { draft: 0.5, final: 1 } as const;

/** Scribe / Forced Alignment: ~$0.40 per audio hour on API pricing. (unconfirmed) */
export const STT_MICROS_PER_SECOND = 112;
export const ALIGN_MICROS_PER_SECOND = 112;

/** Music: ~$0.80 per generated minute. (unconfirmed) */
export const MUSIC_MICROS_PER_SECOND = 13_334;

/** SFX with an explicit duration: ~20 credits per second. (unconfirmed) */
export const SFX_CREDITS_PER_SECOND = 20;

export function ttsMicros(chars: number, quality: "draft" | "final"): number {
  return Math.ceil(chars * TTS_CREDITS_PER_CHAR[quality] * MICROS_PER_CREDIT);
}

export function secondsMicros(durationMs: number, perSecond: number): number {
  return Math.ceil((Math.max(0, durationMs) / 1000) * perSecond);
}

export function sfxMicros(seconds: number): number {
  return Math.ceil(seconds * SFX_CREDITS_PER_SECOND * MICROS_PER_CREDIT);
}
