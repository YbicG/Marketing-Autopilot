/**
 * Browser-side chip guesser for the drop zone. A tiny mirror of core's classifyInput (which pulls
 * server deps): the server re-classifies everything, this only decides which chip to show.
 */
export type LinkKind = "website" | "github" | "unknown";
export type LinkChip = { raw: string; kind: LinkKind };

export const MAX_LINKS = 5;

const GITHUB = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:[/?#].*)?$/i;
const HOSTLIKE = /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

export function guessLink(raw: string): LinkKind {
  if (GITHUB.test(raw)) return "github";
  if (HOSTLIKE.test(raw)) return "website";
  return "unknown";
}

/** Split pasted text on spaces, commas and newlines; de-duplicate, keep order. */
export function splitLinks(text: string): LinkChip[] {
  const seen = new Set<string>();
  const out: LinkChip[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push({ raw: t, kind: guessLink(t) });
  }
  return out;
}

export const LINK_LABEL: Record<LinkKind, string> = {
  website: "Website",
  github: "GitHub",
  unknown: "Not a link",
};
