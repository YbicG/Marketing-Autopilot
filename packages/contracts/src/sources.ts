import { z } from "zod";

export const SourceKind = z.enum(["website", "github", "folder_upload", "text"]);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * public_ok: anything on the product's public website or public repo; may back a public claim.
 * internal: dropped docs and notes. Shapes strategy, never quoted, unless the same text is also public.
 */
export const Visibility = z.enum(["public_ok", "internal"]);
export type Visibility = z.infer<typeof Visibility>;

/** The drop zone's input (§2.3): links, notes and an optional uploaded folder. */
export const IntakeInput = z.object({
  links: z.array(z.string().min(1).max(2_000)).max(5),
  notes: z.string().max(20_000).nullable(),
  /** Set when the browser uploaded a project folder first. */
  folderUploadId: z.string().uuid().nullable(),
});
export type IntakeInput = z.infer<typeof IntakeInput>;

// ── research client tools (§5.2 step 3). Inputs are validated with these before a handler runs. ──

export const RecordFinding = z.object({
  kind: z.enum(["fact", "feature", "price", "audience", "seasonality", "channel", "search_term"]),
  text: z.string().min(1).max(1_000),
  sourceUrl: z.string().max(2_000),
  quote: z.string().max(500).nullable(),
});
export type RecordFinding = z.infer<typeof RecordFinding>;

export const RecordCompetitor = z.object({
  name: z.string().min(1).max(200),
  url: z.string().max(2_000).nullable(),
  summary: z.string().max(1_000),
  pricing: z.string().max(300).nullable(),
  sourceUrl: z.string().max(2_000),
});
export type RecordCompetitor = z.infer<typeof RecordCompetitor>;

export const RecordPain = z.object({
  /** Paraphrased, never a username or a verbatim third-party quote. */
  text: z.string().min(1).max(600),
  audience: z.string().max(200).nullable(),
  sourceUrl: z.string().max(2_000),
});
export type RecordPain = z.infer<typeof RecordPain>;

export const HnSearch = z.object({ query: z.string().min(1).max(200) });
export type HnSearch = z.infer<typeof HnSearch>;

export const ResearchFindings = z.object({
  findings: z.array(RecordFinding),
  competitors: z.array(RecordCompetitor),
  pains: z.array(RecordPain),
});
export type ResearchFindings = z.infer<typeof ResearchFindings>;

/** Sonnet vision labels for one screenshot (ingest.label_asset). */
export const AssetLabel = z.object({
  kind: z.enum(["hero", "feature", "pricing", "dashboard", "mobile", "form", "marketing", "docs", "other"]),
  caption: z.string(),
  visibleText: z.string(),
  /** Regions worth zooming to, as fractions 0..1 of the image. */
  uiRegions: z.array(z.object({ label: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })),
  hasPeople: z.boolean(),
  /** Emails, names, keys or admin data visible on screen. */
  hasPersonalData: z.boolean(),
  usefulForMarketing: z.boolean(),
});
export type AssetLabel = z.infer<typeof AssetLabel>;
