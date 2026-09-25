import { z } from "zod";

/** Results v0 (§5.9): one row per angle. Plain-English column names live in the UI. */
export const AnalyticsWindow = z.enum(["h24", "h72", "d7"]);
export type AnalyticsWindow = z.infer<typeof AnalyticsWindow>;

/**
 * - `none`: no first-party conversion data for this angle yet.
 * - `positive`: at least one signup.
 * - `neutral`: some visits, no signups, too few visits to call it.
 * - `negative`: enough visits (SIGNUP_NEGATIVE_MIN_VISITS) and still no signups.
 */
export const SignupSignal = z.enum(["none", "positive", "neutral", "negative"]);
export type SignupSignal = z.infer<typeof SignupSignal>;

export const AngleResultRow = z.object({
  angleId: z.string(),
  title: z.string(),
  status: z.enum(["active", "stopped"]),
  /** Published posts on this angle, and how many have a mature snapshot (≥ its window). */
  posts: z.number().int(),
  maturePosts: z.number().int(),
  views: z.number().int().nullable(),
  /** "% who tapped the link": link taps ÷ views over mature posts reporting both. */
  linkTapPct: z.number().nullable(),
  profileVisits: z.number().int().nullable(),
  /** Visits and signups from the product's own tracking-link counts (utm_term = angle). */
  visits: z.number().int().nullable(),
  signups: z.number().int().nullable(),
  signupSignal: SignupSignal,
  /** 1-based; null until the angle has ≥3 mature posts. */
  rank: z.number().int().nullable(),
  /** Winner and "Turn into an ad" need rank 1 and a signup signal that isn't negative (and exists). */
  winner: z.boolean(),
  canTurnIntoAd: z.boolean(),
  /** Why there is no rank yet, in plain English. */
  note: z.string().nullable(),
});
export type AngleResultRow = z.infer<typeof AngleResultRow>;

export const ResultsByAngle = z.object({
  productId: z.string(),
  rows: z.array(AngleResultRow),
  /** Mature posts needed before an angle is ranked. */
  minMaturePosts: z.number().int(),
});
export type ResultsByAngle = z.infer<typeof ResultsByAngle>;
