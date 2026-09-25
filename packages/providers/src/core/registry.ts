import type { PublisherAdapter } from "./types.ts";

/**
 * §5.8 step 9: venues the app never posts to itself. It drafts, copies and deep-links; the human
 * posts. definePublisher throws if an adapter claims one of these.
 */
export const ASSISTED_ONLY_TARGETS = [
  "reddit",
  "hackernews",
  "producthunt",
  "indiehackers",
  "devhunt",
  "peerlist",
  "betalist",
  "uneed",
  "discord",
  "directory",
] as const;
export type AssistedVenue = (typeof ASSISTED_ONLY_TARGETS)[number];

export function isAssistedOnly(target: string): boolean {
  return (ASSISTED_ONLY_TARGETS as readonly string[]).includes(target.toLowerCase());
}

const publishers = new Map<string, PublisherAdapter>();

export function definePublisher(adapter: PublisherAdapter): PublisherAdapter {
  const bad = adapter.platforms.filter((p) => isAssistedOnly(p));
  if (bad.length) throw new Error(`publisher ${adapter.meta.id} claims assisted-only venues: ${bad.join(", ")}`);
  publishers.set(adapter.meta.id, adapter);
  return adapter;
}

export function publisher(id: string): PublisherAdapter {
  const p = publishers.get(id);
  if (!p) throw new Error(`unknown publisher ${id}`);
  return p;
}

export function registeredPublishers(): PublisherAdapter[] {
  return [...publishers.values()];
}
