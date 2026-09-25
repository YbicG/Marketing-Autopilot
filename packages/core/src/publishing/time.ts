/** YYYY-MM-DD of `d` in the IANA time zone `tz` (the workspace's). */
export function localDay(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "Tue 7:30 pm" in `tz`. */
export function shortSlot(d: Date, tz: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .format(d)
    .replace(/\s?AM$/i, " am")
    .replace(/\s?PM$/i, " pm");
  return `${weekday} ${time}`;
}

/** ISO week "2026-W39" (Monday-based) of `d` in `tz`. */
export function isoWeek(d: Date, tz: string): string {
  const [y, m, day] = localDay(d, tz).split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, day));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
