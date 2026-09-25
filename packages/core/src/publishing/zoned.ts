import { localDay } from "./time.ts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Offset of `tz` from UTC at instant `d`, in ms (New York in October → -4 h). */
function tzOffsetMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** The instant of local wall-clock `day` `hh:mm` in `tz`. Throws a plain sentence on bad input. */
export function zonedTime(day: string, hhmm: string, tz: string): Date {
  const t = TIME_RE.exec(hhmm);
  if (!DAY_RE.test(day) || !t) throw new Error("Pick a day and a time.");
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Number(t[1]), Number(t[2]));
  // Two passes settle the offset across a DST change.
  let at = guess - tzOffsetMs(new Date(guess), tz);
  at = guess - tzOffsetMs(new Date(at), tz);
  return new Date(at);
}

/** "19:30" in `tz`. */
export function localTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

/** Drag-to-reschedule: same local time of day, on `day`. */
export function moveToDay(scheduledAt: Date, day: string, tz: string): Date {
  return zonedTime(day, localTime(scheduledAt, tz), tz);
}

/** YYYY-MM-DD plus `n` days (calendar arithmetic, no time zone). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the week containing `day`. */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(day, 1 - dow);
}

/** [start, end) instants of local `day` in `tz`. */
export function dayBounds(day: string, tz: string): { from: Date; to: Date } {
  return { from: zonedTime(day, "00:00", tz), to: zonedTime(addDays(day, 1), "00:00", tz) };
}

export function localToday(now: Date, tz: string): string {
  return localDay(now, tz);
}
