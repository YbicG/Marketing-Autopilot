import type { NeedsYouItem, PostDetail } from "@mkt/core/publishing";

// Plain, serializable shapes passed from server pages / JSON routes to the publishing components.
// Type-only imports from core are erased, so these files stay safe for "use client".

export type PostDetailJson = Omit<PostDetail, "scheduledAt" | "approvedAt"> & { scheduledAt: string; approvedAt: string | null };

export type NeedsYouJson = NeedsYouItem;

export interface QueueChip {
  id: string;
  platform: string;
  state: string;
  mode: string;
  handle: string | null;
  /** "7:30 pm" in the workspace time zone. */
  time: string;
  conflicts: string[];
  lastError: string | null;
}

export interface CreatorInfoJson {
  privacyOptions: string[];
  canPost: boolean;
  maxVideoSeconds?: number;
  commentDisabled?: boolean;
  duetDisabled?: boolean;
  stitchDisabled?: boolean;
}

export interface Issue {
  code: string;
  message: string;
  severity: "block" | "warn";
}
