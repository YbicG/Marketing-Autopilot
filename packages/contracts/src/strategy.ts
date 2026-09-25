import { z } from "zod";

/** One angle card (§2.3 "Here's your plan"). */
export const AngleCard = z.object({
  title: z.string(),
  /** Who it's for. */
  forWho: z.string(),
  /** What they use today instead. */
  insteadOf: z.string(),
  /** The promise, in one sentence. */
  promise: z.string(),
  sampleOpeningLine: z.string(),
  bestOn: z.array(z.string()),
  whyWeSuggest: z.string(),
  /** Claim ids (C1…) this angle leans on; only public claims may be used in posts. */
  claimIds: z.array(z.string()),
  /** Up to 3 real screenshots (asset ids from the evidence bundle). */
  screenshotAssetIds: z.array(z.string()),
});
export type AngleCard = z.infer<typeof AngleCard>;

/** strategy.positioning output (Opus). */
export const StrategyOutput = z.object({
  angles: z.array(AngleCard),
  messaging: z.object({
    oneLiners: z.array(z.string()),
    elevatorPitch: z.string(),
    objections: z.array(z.object({ objection: z.string(), answer: z.string() })),
    wordsToUse: z.array(z.string()),
    wordsToAvoid: z.array(z.string()),
  }),
  channelPlan: z.array(z.object({ platform: z.string(), role: z.string(), cadence: z.string() })),
  launchWindow: z.object({
    /** ISO date (YYYY-MM-DD) or null when there's no seasonal anchor. */
    suggestedDate: z.string().nullable(),
    reason: z.string(),
  }),
});
export type StrategyOutput = z.infer<typeof StrategyOutput>;
export const ANGLE_COUNT = 3;
