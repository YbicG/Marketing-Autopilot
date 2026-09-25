/** Board card → its editor (§2.3). Videos open W4's video editor. */
export function editorHref(slug: string, card: { kind: string; contentItemId: string }): string {
  const base = `/p/${encodeURIComponent(slug)}/content`;
  if (card.kind === "carousel") return `${base}/carousel/${card.contentItemId}`;
  if (card.kind === "video") return `${base}/video/${card.contentItemId}`;
  return `${base}/post/${card.contentItemId}`;
}
