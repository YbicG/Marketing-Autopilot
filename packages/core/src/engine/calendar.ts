import {
  OPENING_STYLES,
  type Audience,
  type CampaignPlan,
  type ContentKind,
  type OpeningStyle,
  type PackageRecipe,
  type PlanItem,
  type PlanSlot,
  type PostFormat,
  type RecipeLine,
  type SocialPlatform,
} from "@mkt/contracts";

// The calendar planner (§5.3). PURE: no DB, no clock. Claude only writes the briefs afterwards.
// Rules (§2.5): 2 per platform per day per product; a connection's own cap (hard max 3), shared
// accounts counting other products' posts; 1 a day while an account warms up; launch on D14 (a
// Tuesday by default, D21); angles 60/20/20; varied opening styles; one opening line per master per
// account; masters sharing >50% of scenes ≥7 days apart on an account. Anything that doesn't fit is
// reported as overflow, and slots whose generator is off are Open (D12: never padded).

export const PRODUCT_CAP_PER_DAY = 2;
export const CONNECTION_HARD_MAX = 3;
export const WARMUP_PER_DAY = 1;
export const MASTER_SPACING_DAYS = 7;
export const LAUNCH_DAY = 14;

/** §2.5 posting times, local to the audience: students 7–10 pm; B2B Tue–Thu 8–10 am; developers 8–11 am. */
export const DEFAULT_TIMES: Record<Audience, { weekdays: number[]; times: string[] }> = {
  students: { weekdays: [0, 1, 2, 3, 4, 5, 6], times: ["19:30", "21:00"] },
  b2b: { weekdays: [2, 3, 4], times: ["08:30", "09:30"] },
  developers: { weekdays: [1, 2, 3, 4, 5], times: ["08:30", "10:30"] },
  general: { weekdays: [0, 1, 2, 3, 4, 5, 6], times: ["12:00", "18:30"] },
};

export interface PlatformPlanInput {
  platform: SocialPlatform;
  connectionId: string | null;
  /** A personal account shared across products (the per-account cap spans them). */
  shared: boolean;
  /** The connection's own cap, 1..3. */
  maxPerDay: number;
  /** Local date (YYYY-MM-DD); days before it are warm-up days (1 post). */
  warmupUntil: string | null;
  /** Posts other products already have on this account, by local date. */
  usedByOthers: Record<string, number>;
  /** Posting schedule; null = the audience defaults. weekday 0 = Sunday. */
  schedule: { weekday: number; time: string }[] | null;
}

export interface PlannerInput {
  recipe: PackageRecipe;
  /** YYYY-MM-DD. */
  launchDate: string;
  /** Day 1. Default: launch − 13, so the launch is D14. */
  startDate?: string | null;
  timezone: string;
  /** Per platform; platforms missing here are planned as unconnected with the defaults. */
  platforms?: PlatformPlanInput[];
  angleCount?: number;
  angleShares?: readonly number[];
  /** Pairs of master indexes that share more than half their scenes. */
  masterOverlaps?: readonly (readonly [number, number])[];
}

// ── dates ──

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function tzOffsetMs(utcMs: number, tz: string): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A local wall-clock time in `tz` as a UTC ISO string (DST-aware; a skipped hour moves forward). */
export function zonedToUtc(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = tzOffsetMs(guess, tz);
  let ts = guess - off;
  const off2 = tzOffsetMs(ts, tz);
  if (off2 !== off) ts = guess - off2;
  return new Date(ts).toISOString();
}

// ── planning ──

interface Request {
  line: RecipeLine;
  lineOrder: number;
  itemIdx: number;
  platform: SocialPlatform;
  format: PostFormat;
  frac: number;
  ideal: number;
  launch: boolean;
}

interface Placed extends Request {
  day: number;
}

export const itemKey = (kind: ContentKind, lineKey: string, idx: number) =>
  `${kind}:${lineKey}-${String(idx + 1).padStart(2, "0")}`;

function defaultInput(platform: SocialPlatform): PlatformPlanInput {
  return { platform, connectionId: null, shared: false, maxPerDay: PRODUCT_CAP_PER_DAY, warmupUntil: null, usedByOthers: {}, schedule: null };
}

function timesFor(input: PlatformPlanInput, audience: Audience, date: string): string[] {
  const wd = weekday(date);
  if (input.schedule?.length) {
    return [...new Set(input.schedule.filter((s) => s.weekday === wd).map((s) => s.time))].sort();
  }
  const def = DEFAULT_TIMES[audience];
  return def.weekdays.includes(wd) ? [...def.times] : [];
}

/** How many posts this platform can take on each day (index 1..days). */
export function dayCapacity(input: PlatformPlanInput, audience: Audience, startDate: string, days: number): { cap: number[]; times: string[][] } {
  const cap: number[] = [0];
  const times: string[][] = [[]];
  const conn = Math.min(Math.max(1, input.maxPerDay), CONNECTION_HARD_MAX);
  for (let d = 1; d <= days; d++) {
    const date = addDays(startDate, d - 1);
    const ts = timesFor(input, audience, date);
    let c = Math.min(PRODUCT_CAP_PER_DAY, conn - (input.usedByOthers[date] ?? 0), ts.length);
    if (input.warmupUntil && date < input.warmupUntil) c = Math.min(c, WARMUP_PER_DAY);
    cap.push(Math.max(0, c));
    times.push(ts);
  }
  return { cap, times };
}

/** Smooth weighted round-robin: deterministic 60/20/20 spread, with forced picks for launch items. */
function angleSequence(shares: number[]) {
  const total = shares.reduce((a, b) => a + b, 0);
  const current = shares.map(() => 0);
  return (forced: number | null): number => {
    for (let i = 0; i < shares.length; i++) current[i]! += shares[i]!;
    let pick = forced ?? 0;
    if (forced === null) for (let i = 1; i < shares.length; i++) if (current[i]! > current[pick]!) pick = i;
    current[pick]! -= total;
    return pick;
  };
}

export function planCalendar(input: PlannerInput): CampaignPlan {
  const { recipe } = input;
  const days = recipe.days;
  const warnings: string[] = [];
  const startDate = input.startDate ?? addDays(input.launchDate, -(LAUNCH_DAY - 1));
  const launchDay = daysBetween(startDate, input.launchDate) + 1;
  if (launchDay < 1 || launchDay > days) warnings.push(`The launch day (${input.launchDate}) is outside these ${days} days.`);
  if (weekday(input.launchDate) !== 2) warnings.push(`The launch day (${input.launchDate}) isn't a Tuesday.`);

  const angleCount = Math.max(1, input.angleCount ?? 3);
  const rawShares = (input.angleShares ?? [60, 20, 20]).slice(0, angleCount);
  while (rawShares.length < angleCount) rawShares.push(Math.round(100 / angleCount));
  const overlaps = input.masterOverlaps ?? [];
  const byPlatform = new Map((input.platforms ?? []).map((p) => [p.platform, p]));

  const slots: PlanSlot[] = [];
  const overflow = new Map<string, CampaignPlan["overflow"][number]>();
  const placed: Placed[] = [];

  const platforms = [...new Set(recipe.lines.filter((l) => l.scheduled).flatMap((l) => l.targets.map((t) => t.platform)))];
  for (const platform of platforms) {
    const pin = byPlatform.get(platform) ?? defaultInput(platform);
    const { cap, times } = dayCapacity(pin, recipe.audience, startDate, days);

    const reqs: Request[] = [];
    recipe.lines.forEach((line, lineOrder) => {
      if (!line.scheduled) return;
      for (const t of line.targets) {
        if (t.platform !== platform) continue;
        for (let i = 0; i < Math.min(t.count, line.count); i++) {
          reqs.push({ line, lineOrder, itemIdx: i, platform, format: t.format, frac: (i + 0.5) / t.count, ideal: 0, launch: false });
        }
      }
    });
    if (!reqs.length) continue;
    reqs.sort((a, b) => a.frac - b.frac || a.lineOrder - b.lineOrder || a.itemIdx - b.itemIdx);
    reqs.forEach((r, k) => (r.ideal = Math.min(days, 1 + Math.floor(((k + 0.5) * days) / reqs.length))));

    // The launch day gets this platform's nearest deliverable, preferring one that will be generated.
    if (launchDay >= 1 && launchDay <= days) {
      const pool = reqs.some((r) => r.line.enabled) ? reqs.filter((r) => r.line.enabled) : reqs;
      const nearest = pool.reduce((best, r) => (Math.abs(r.ideal - launchDay) < Math.abs(best.ideal - launchDay) ? r : best));
      nearest.ideal = launchDay;
      nearest.launch = true;
    }

    const used = cap.map(() => 0);
    const masterDays = new Map<number, number>();
    const conflicts = (r: Request, day: number) =>
      r.line.kind === "video" &&
      overlaps.some(([a, b]) => {
        const other = a === r.itemIdx ? b : b === r.itemIdx ? a : null;
        if (other === null) return false;
        const od = masterDays.get(other);
        return od !== undefined && Math.abs(od - day) < MASTER_SPACING_DAYS;
      });
    const order = [...reqs].sort((a, b) => Number(b.launch) - Number(a.launch) || a.ideal - b.ideal);
    for (const r of order) {
      let day = -1;
      for (let off = 0; off <= days && day < 0; off++) {
        for (const d of off === 0 ? [r.ideal] : [r.ideal + off, r.ideal - off]) {
          if (d < 1 || d > days || used[d]! >= cap[d]!) continue;
          if (conflicts(r, d)) continue;
          if (r.launch && d !== launchDay) r.launch = false;
          day = d;
          break;
        }
      }
      if (day < 0) {
        const key = `${platform}|${r.format}|${r.line.key}`;
        const o = overflow.get(key) ?? { platform, format: r.format, lineKey: r.line.key, count: 0 };
        o.count++;
        overflow.set(key, o);
        continue;
      }
      used[day]!++;
      if (r.line.kind === "video") masterDays.set(r.itemIdx, day);
      placed.push({ ...r, day });
    }

    // Times: in day order, the n-th post of a day takes the n-th posting time.
    const mine = placed.filter((p) => p.platform === platform).sort((a, b) => a.day - b.day || Number(b.launch) - Number(a.launch));
    const perDay = new Map<number, number>();
    for (const p of mine) {
      const n = perDay.get(p.day) ?? 0;
      perDay.set(p.day, n + 1);
      const date = addDays(startDate, p.day - 1);
      const time = times[p.day]![n]!;
      const videoPlatforms = p.line.targets.map((t) => t.platform);
      slots.push({
        id: `${platform}-d${String(p.day).padStart(2, "0")}-${n + 1}`,
        day: p.day,
        date,
        time,
        scheduledAt: zonedToUtc(date, time, input.timezone),
        platform,
        format: p.format,
        kind: p.line.kind,
        lineKey: p.line.key,
        connectionId: pin.connectionId,
        status: p.line.enabled ? "filled" : "open",
        openReason: p.line.enabled ? null : "coming_soon",
        deliverableKey: p.line.enabled ? itemKey(p.line.kind, p.line.key, p.itemIdx) : null,
        angleIdx: null,
        openingStyle: null,
        hookIdx: p.line.kind === "video" ? (videoPlatforms.indexOf(platform) + p.itemIdx) % (p.line.hooksPerMaster ?? 1) : null,
        masterIdx: p.line.kind === "video" ? p.itemIdx : null,
        launch: p.launch && p.day === launchDay,
      });
    }
  }

  // Items: one per enabled deliverable that got at least one slot, plus the unscheduled drafts.
  const items: PlanItem[] = [];
  recipe.lines.forEach((line) => {
    if (!line.enabled) return;
    for (let i = 0; i < line.count; i++) {
      const key = itemKey(line.kind, line.key, i);
      const mine = slots.filter((s) => s.deliverableKey === key);
      if (line.scheduled && !mine.length) continue;
      items.push({
        deliverableKey: key,
        kind: line.kind,
        generator: line.generator,
        lineKey: line.key,
        idx: i,
        angleIdx: 0,
        openingStyle: OPENING_STYLES[0],
        day: mine.length ? Math.min(...mine.map((s) => s.day)) : null,
        slotIds: mine.map((s) => s.id),
        targets: line.scheduled
          ? mine.map((s) => ({ platform: s.platform, format: s.format }))
          : line.targets.map((t) => ({ platform: t.platform, format: t.format })),
        masterIdx: line.kind === "video" ? i : null,
        launch: mine.some((s) => s.launch),
      });
    }
  });
  const lineOrder = new Map(recipe.lines.map((l, i) => [l.key, i]));
  items.sort((a, b) => (a.day ?? 999) - (b.day ?? 999) || lineOrder.get(a.lineKey)! - lineOrder.get(b.lineKey)! || a.idx - b.idx);

  // Angles 60/20/20 over the scheduled items in day order; launch items and drafts lead with #1.
  const nextAngle = angleSequence(rawShares);
  // Opening styles: least used so far, never the same as the previous one on any of the item's platforms.
  const styleUse = new Map<OpeningStyle, number>(OPENING_STYLES.map((s) => [s, 0]));
  const lastStyle = new Map<SocialPlatform, OpeningStyle>();
  for (const item of items) {
    item.angleIdx = item.day === null ? 0 : nextAngle(item.launch ? 0 : null);
    const platformsOf = item.targets.map((t) => t.platform);
    const ranked = [...OPENING_STYLES].sort((a, b) => styleUse.get(a)! - styleUse.get(b)! || OPENING_STYLES.indexOf(a) - OPENING_STYLES.indexOf(b));
    const style = ranked.find((s) => platformsOf.every((p) => lastStyle.get(p) !== s)) ?? ranked[0]!;
    item.openingStyle = style;
    styleUse.set(style, styleUse.get(style)! + 1);
    if (item.day !== null) for (const p of platformsOf) lastStyle.set(p, style);
  }
  const byKey = new Map(items.map((i) => [i.deliverableKey, i]));
  for (const s of slots) {
    const item = s.deliverableKey ? byKey.get(s.deliverableKey) : undefined;
    if (item) {
      s.angleIdx = item.angleIdx;
      s.openingStyle = item.openingStyle;
    }
  }
  slots.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.platform.localeCompare(b.platform));

  const over = [...overflow.values()];
  for (const o of over) warnings.push(`${o.count} ${o.lineKey} for ${o.platform} didn't fit under the daily limits.`);
  return {
    schemaVersion: 1,
    startDate,
    launchDate: input.launchDate,
    launchDay,
    timezone: input.timezone,
    days,
    slots,
    items,
    overflow: over,
    warnings,
  };
}
