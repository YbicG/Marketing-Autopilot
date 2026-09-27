import { and, eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { LINK_TOKEN } from "./links.ts";
import { addDays } from "./zoned.ts";

const { auditLog, products } = schema;

// D24: links on X only while the $19/mo Upload-Post links add-on is on (launch week). The window is
// products.x_links_from..x_links_until, inclusive local dates in the workspace time zone.

export interface XLinksWindow {
  from: string;
  until: string;
}

export interface XLinksProduct {
  xLinksFrom: string | null;
  xLinksUntil: string | null;
}

/** Without a window, generation keeps X links for launch day ±3 (the old launch-week rule). */
export const X_LINKS_FALLBACK_DAYS = 3;
/** The add-on is billed monthly; a window longer than a month is almost certainly a typo. */
export const X_LINKS_MAX_DAYS = 31;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(d: string): boolean {
  if (!DAY_RE.test(d)) return false;
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
}

/** Whole days from `a` to `b` (calendar dates, no time zone). */
function daysBetween(a: string, b: string): number {
  const ms = (d: string) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export function xLinksWindowOf(p: XLinksProduct): XLinksWindow | null {
  return p.xLinksFrom && p.xLinksUntil ? { from: p.xLinksFrom, until: p.xLinksUntil } : null;
}

export const inXLinksWindow = (w: XLinksWindow, day: string) => day >= w.from && day <= w.until;

/**
 * Generation side (engine validate/package/refill/editor): may an X post on local `day` carry a link?
 * Inside the product's add-on window; with no window set, launch day ±3; with neither, no.
 */
export function xLinksAllowedOn(p: XLinksProduct, day: string | null, launchDate: string | null = null): boolean {
  if (!day) return false;
  const w = xLinksWindowOf(p);
  if (w) return inXLinksWindow(w, day);
  return !!launchDate && Math.abs(daysBetween(launchDate, day)) <= X_LINKS_FALLBACK_DAYS;
}

const RAW_URL = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/i;

/** Does the text still carry a link: a `{{link:…}}` token or a typed web address? */
export function linkKinds(texts: readonly string[]): { token: boolean; raw: boolean } {
  const tokenRe = new RegExp(LINK_TOKEN.source, "i");
  const token = texts.some((t) => tokenRe.test(t));
  const raw = texts.some((t) => RAW_URL.test(t.replace(new RegExp(LINK_TOKEN.source, "gi"), "")));
  return { token, raw };
}

/** "Tue, Jan 5" for a local ISO date. */
export function plainDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const xLinksBlockMessage = (day: string) =>
  `The X links add-on isn't on for ${plainDay(day)}. Remove the link or set the add-on dates in Settings.`;

/**
 * Publish side (publish.prepare, X only). With a window set, it decides: links are live inside it,
 * and any link (token or typed address) outside it blocks the post. With no window, the older
 * per-connection flag decides and a token quietly becomes "link in bio" (the bio carries the tracking);
 * a typed address can't be rewritten, so it blocks unless the flag is on.
 */
export function xLinksAtPublish(input: {
  window: XLinksWindow | null;
  day: string;
  connectionAddon: boolean;
  links: { token: boolean; raw: boolean };
}): { linksAllowed: boolean; block: string | null } {
  const any = input.links.token || input.links.raw;
  if (input.window) {
    if (inXLinksWindow(input.window, input.day)) return { linksAllowed: true, block: null };
    return { linksAllowed: false, block: any ? xLinksBlockMessage(input.day) : null };
  }
  if (input.connectionAddon) return { linksAllowed: true, block: null };
  return { linksAllowed: false, block: input.links.raw ? xLinksBlockMessage(input.day) : null };
}

/** Plain-English problem with a window, or null when it's fine. */
export function validateXLinksWindow(w: XLinksWindow): string | null {
  if (!isRealDay(w.from) || !isRealDay(w.until)) return "Pick a start and an end date.";
  if (w.from > w.until) return "The end date is before the start date.";
  const span = daysBetween(w.from, w.until) + 1;
  if (span > X_LINKS_MAX_DAYS) return `That's ${span} days. The add-on window can be at most ${X_LINKS_MAX_DAYS} days.`;
  return null;
}

export type SetXLinksResult = { ok: true; window: XLinksWindow | null } | { ok: false; error: string };

/**
 * Settings → Where to post: the dates CJ turned the Upload-Post X links add-on on for. `null` clears
 * it (X posts then point to the bio link). Workspace-scoped; writes an audit_log row.
 */
export async function setXLinksWindow(
  db: Db,
  workspaceId: string,
  productId: string,
  window: XLinksWindow | null,
  userId: string,
): Promise<SetXLinksResult> {
  if (window) {
    const problem = validateXLinksWindow(window);
    if (problem) return { ok: false, error: problem };
  }
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ from: products.xLinksFrom, until: products.xLinksUntil })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
    if (!before) return { ok: false as const, error: "That project wasn't found." };
    await tx
      .update(products)
      .set({ xLinksFrom: window?.from ?? null, xLinksUntil: window?.until ?? null })
      .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
    await tx.insert(auditLog).values({
      id: uuidv7(),
      workspaceId,
      actorType: "user",
      actorId: userId,
      action: "product.x_links_window",
      entity: `product:${productId}`,
      data: { before: before.from && before.until ? before : null, after: window },
    });
    return { ok: true as const, window };
  });
}

/** The window the settings form pre-fills: launch day ±3 (7 days, the same as the fallback). */
export function suggestedXLinksWindow(launchDate: string): XLinksWindow {
  return { from: addDays(launchDate, -X_LINKS_FALLBACK_DAYS), until: addDays(launchDate, X_LINKS_FALLBACK_DAYS) };
}
