import type { AnalyticsGateway, AnalyticsJob, AnalyticsWindowName } from "../publishing/scheduler.ts";

/** §5.9: pulls at +24 h, +72 h and +7 d after publish. */
export const WINDOW_HOURS: Record<AnalyticsWindowName, number> = { h24: 24, h72: 72, d7: 168 };
export const WINDOWS = Object.keys(WINDOW_HOURS) as AnalyticsWindowName[];

export function analyticsJobId(postId: string, window: AnalyticsWindowName): string {
  return `an_${postId}_${window}`;
}

export function analyticsJobsFor(postId: string, publishedAt: Date, skip: AnalyticsWindowName[] = []): AnalyticsJob[] {
  return WINDOWS.filter((w) => !skip.includes(w)).map((window) => ({
    jobId: analyticsJobId(postId, window),
    postId,
    window,
    runAt: new Date(publishedAt.getTime() + WINDOW_HOURS[window] * 3_600_000),
  }));
}

/** Idempotent by jobId: safe to call on publish and again from boot.rehydrate. */
export async function ensureAnalyticsWindows(
  gw: AnalyticsGateway,
  postId: string,
  publishedAt: Date,
  skip: AnalyticsWindowName[] = [],
): Promise<number> {
  let created = 0;
  for (const job of analyticsJobsFor(postId, publishedAt, skip)) {
    if ((await gw.ensure(job)) === "created") created++;
  }
  return created;
}
