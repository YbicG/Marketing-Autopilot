import { and, eq, inArray } from "drizzle-orm";
import { ADS_LIMITS, ADS_SPEND_STATEMENT, AD_PLATFORMS, AdsExportBody, type AdCopy, type AdPlatform, type AdPlatformExport } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import type { Storage } from "../media/storage.ts";
import { withUtm } from "../publishing/links.ts";

const { assets, launchKits, products, renders } = schema;

// The ads export package (§6 Ads row "export package"): per-platform sheets, a README with the setup
// steps, the kit as JSON, and the creative files. The sheets only approximate each platform's bulk
// upload template (column names and order unverified against the live templates); the README says so.

export interface ExportFile {
  path: string;
  bytes: Uint8Array;
}

/** A creative the body points at, resolved to the file that holds it (a render → its output asset). */
export interface ResolvedCreative {
  /** The id in the body (assets.id or renders.id). */
  refId: string;
  assetId: string;
  mime: string;
}

export interface AdsExportCtx {
  productName: string;
  productSlug: string;
  /** The product's website; null leaves the link column for CJ to fill. */
  landingUrl: string | null;
}

export class AdsExportRefused extends Error {}

const enc = new TextEncoder();
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" };

/** One CSV cell: quoted when needed; a leading = + - @ is defused so a spreadsheet never runs it. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const csv = (rows: (string | number | null)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function adLink(ctx: AdsExportCtx, platform: AdPlatform, conceptIdx: number): string {
  if (!ctx.landingUrl) return "";
  return withUtm(ctx.landingUrl, { utm_source: platform, utm_medium: "paid", utm_campaign: `${ctx.productSlug}-ads`, utm_content: `idea-${conceptIdx + 1}` });
}

const STATUS = "PAUSED";
const AGE = "18+";

interface Row {
  copy: AdCopy;
  name: string;
  placement: string;
  file: string;
  link: string;
}

function rowsFor(p: AdPlatformExport, ctx: AdsExportCtx, fileOf: (refId: string) => string): Row[] {
  const out: Row[] = [];
  const counts = new Map<number, number>();
  for (const copy of p.copy) {
    const n = (counts.get(copy.conceptIdx) ?? 0) + 1;
    counts.set(copy.conceptIdx, n);
    const name = `Idea ${copy.conceptIdx + 1}${String.fromCharCode(96 + n)}`;
    const creatives = p.creatives.filter((c) => c.conceptIdx === copy.conceptIdx);
    const placements = creatives.length ? creatives : [{ placement: p.placements[0]?.name ?? "", id: "" }];
    for (const c of placements) out.push({ copy, name, placement: c.placement, file: c.id ? fileOf(c.id) : "", link: adLink(ctx, p.platform, copy.conceptIdx) });
  }
  return out;
}

function sheet(platform: AdPlatform, p: AdPlatformExport, ctx: AdsExportCtx, fileOf: (refId: string) => string): string {
  const campaign = `${ctx.productName} launch · ${ADS_LIMITS[platform].label}`;
  const rows = rowsFor(p, ctx, fileOf);
  switch (platform) {
    case "meta":
      return csv([
        ["Campaign Name", "Campaign Status", "Ad Set Name", "Ad Set Daily Budget", "Ad Set Time Stop", "Age Min", "Ad Name", "Body", "Title", "Link Description", "Call to Action", "Link", "Image or Video File", "Placement"],
        ...rows.map((r) => [campaign, STATUS, `${campaign} · ${r.placement}`, "", "", 18, r.name, r.copy.primaryText, r.copy.headline, r.copy.description, r.copy.callToAction, r.link, r.file, r.placement]),
      ]);
    case "tiktok":
      return csv([
        ["Campaign name", "Status", "Ad group name", "Daily budget", "Schedule end", "Age", "Ad name", "Ad text", "Call to action", "URL", "Video file", "Placement"],
        ...rows.map((r) => [campaign, STATUS, `${campaign} · ${r.placement}`, "", "", AGE, r.name, r.copy.primaryText, r.copy.callToAction, r.link, r.file, r.placement]),
      ]);
    case "reddit":
      return csv([
        ["Campaign", "Status", "Ad group", "Daily budget", "End date", "Age", "Ad name", "Headline", "Call to action", "URL", "Media file", "Placement"],
        ...rows.map((r) => [campaign, STATUS, `${campaign} · ${r.placement}`, "", "", AGE, r.name, r.copy.headline, r.copy.callToAction, r.link, r.file, r.placement]),
      ]);
    case "linkedin":
      return csv([
        ["Campaign", "Status", "Daily budget", "End date", "Age", "Ad name", "Introductory text", "Headline", "Description", "Call to action", "Destination URL", "Image or video file", "Placement"],
        ...rows.map((r) => [campaign, STATUS, "", "", AGE, r.name, r.copy.primaryText, r.copy.headline, r.copy.description, r.copy.callToAction, r.link, r.file, r.placement]),
      ]);
    case "x":
      return csv([
        ["Campaign", "Status", "Ad group", "Daily budget", "End date", "Age", "Ad name", "Post text", "Card headline", "Website URL", "Media file", "Placement"],
        ...rows.map((r) => [campaign, STATUS, `${campaign} · ${r.placement}`, "", "", AGE, r.name, r.copy.primaryText, r.copy.headline, r.link, r.file, r.placement]),
      ]);
    case "apple_search_ads":
      return csv([["Keyword", "Match type", "Status"], ...p.keywords.map((k) => [k, "Exact", STATUS])]);
  }
}

function readme(body: AdsExportBody, ctx: AdsExportCtx, fileOf: (refId: string) => string, sheets: Map<AdPlatform, string>): string {
  const lines: string[] = [
    `# Ads kit: ${ctx.productName}`,
    "",
    `**${ADS_SPEND_STATEMENT}.**`,
    "",
    "These files are for you to upload by hand. The app never connects to an ads platform and never turns an ad on.",
    "",
    "## Before you upload, on every platform",
    "",
    "1. Create every campaign **paused**. The sheets say PAUSED; keep it that way until you've checked the preview.",
    "2. Show ads to people **18 and over** only.",
    "3. Set a **daily limit** on the platform itself. It's the real safety net: it holds even if this app is down.",
    "4. Set an **end date**. Don't leave any campaign open-ended.",
    "5. Use the website link from the sheet: it has tracking built in, so signups show up under the right idea.",
    "6. Turn an ad on only after your launch-day posts are live and the tracking test has passed.",
    "",
    `Budget: ${body.budgetNote}`,
    "",
    `Launch day: ${body.launchDate}.`,
    "",
    "## The 3 ideas",
    "",
  ];
  for (const c of body.concepts) {
    const pics = [...c.visual.renderIds, ...c.visual.assetIds].map(fileOf).filter(Boolean);
    lines.push(
      `### Idea ${c.idx + 1}: ${c.angle}`,
      "",
      `- Opening line: ${c.openingLine}`,
      `- Shows: ${c.visual.description || "(pick a screenshot or video)"}`,
      `- Pictures: ${pics.length ? pics.join(", ") : "none yet; add one before you upload"}`,
      `- Why: ${c.why}`,
      ...(c.claimRefs.length ? [`- Facts used: ${c.claimRefs.join(", ")}`] : []),
      "",
    );
  }
  lines.push("## Platform by platform", "");
  for (const platform of AD_PLATFORMS) {
    const p = body.platforms[platform];
    const l = ADS_LIMITS[platform];
    lines.push(`### ${l.label}`, "");
    if (p.skipped) {
      lines.push(`Skipped: ${p.skipped}`, "");
      continue;
    }
    lines.push(`- Sheet: ${sheets.get(platform) ?? "none"}`, `- Who to show it to: ${p.audience || "(fill in)"}`);
    for (const pl of p.placements) lines.push(`- ${pl.name} (${pl.aspect.replace("x", ":")}): ${pl.notes}`);
    if (platform === "apple_search_ads") {
      lines.push(`- ${p.keywords.length} keywords, exact match. The ad itself is your App Store listing.`);
    } else {
      const fields = (["primaryText", "headline", "description"] as const).filter((f) => l.fields[f]);
      for (const c of p.copy) {
        const parts = fields.map((f) => (c[f] ? `${l.fields[f]!.label}: "${c[f]}" (${c[f]!.length})` : null)).filter(Boolean);
        lines.push(`- Idea ${c.conceptIdx + 1}: ${parts.join(" · ")}${c.callToAction ? ` · Button: ${c.callToAction}` : ""}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "## About these files",
    "",
    "- The .csv sheets follow the general shape of each platform's bulk upload template, but they are approximations: the column names weren't checked against the live templates. If an upload complains, copy the text across by hand.",
    "- Character limits come from each platform's published ad specs and weren't re-checked against the live ads managers. The platform's own counter wins.",
    "- `ads.json` is the whole kit, for the app's own records.",
    "- Pictures and videos are in `creatives/`, named by idea.",
    "",
  );
  return lines.join("\n");
}

/**
 * Pure: the kit body (+ the files its creatives resolve to) → the text files of the export and the
 * list of media files to add. `adsExportFiles` reads the media bytes.
 */
export function buildAdsExport(
  body: AdsExportBody,
  creatives: readonly ResolvedCreative[],
  ctx: AdsExportCtx,
): { files: ExportFile[]; media: { path: string; assetId: string }[] } {
  const byRef = new Map(creatives.map((c) => [c.refId, c]));
  const names = new Map<string, string>();
  const ideaOf = new Map<string, number>();
  for (const c of body.concepts) for (const id of [...c.visual.renderIds, ...c.visual.assetIds]) if (!ideaOf.has(id)) ideaOf.set(id, c.idx);
  for (const p of Object.values(body.platforms)) for (const c of p.creatives) if (!ideaOf.has(c.id)) ideaOf.set(c.id, c.conceptIdx);
  const fileOf = (refId: string): string => {
    const c = byRef.get(refId);
    if (!c) return "";
    let name = names.get(refId);
    if (!name) {
      name = `creatives/idea-${(ideaOf.get(refId) ?? 0) + 1}-${refId.replaceAll("-", "").slice(-8)}.${EXT[c.mime] ?? "bin"}`;
      names.set(refId, name);
    }
    return name;
  };

  const files: ExportFile[] = [];
  const sheets = new Map<AdPlatform, string>();
  for (const platform of AD_PLATFORMS) {
    const p = body.platforms[platform];
    if (p.skipped) continue;
    const path = platform === "apple_search_ads" ? `${platform}/keywords.csv` : `${platform}/ads.csv`;
    sheets.set(platform, path);
    files.push({ path, bytes: enc.encode(sheet(platform, p, ctx, fileOf)) });
  }
  // Every creative the README or sheets named, plus concept pictures no placement picked.
  for (const c of body.concepts) for (const id of [...c.visual.renderIds, ...c.visual.assetIds]) fileOf(id);
  files.unshift({ path: "README.md", bytes: enc.encode(readme(body, ctx, fileOf, sheets)) });
  files.push({ path: "ads.json", bytes: enc.encode(JSON.stringify(body, null, 2)) });
  const media = [...names.entries()].map(([refId, path]) => ({ path, assetId: byRef.get(refId)!.assetId }));
  return { files, media };
}

/**
 * The files of one ads kit's export, for the launch kit module (or the web route) to zip with
 * `zipStore`. Workspace-scoped. Throws AdsExportRefused (plain sentence) unless the kit is ready.
 */
export async function adsExportFiles(db: Db, storage: Storage, workspaceId: string, kitId: string): Promise<ExportFile[]> {
  const [kit] = await db.select().from(launchKits).where(and(eq(launchKits.id, kitId), eq(launchKits.workspaceId, workspaceId)));
  if (!kit || kit.kind !== "ads_export") throw new AdsExportRefused("That ads kit wasn't found.");
  if (kit.status !== "ready" || !kit.disclosuresOk) throw new AdsExportRefused(kit.needsYouReason ? `Fix this first: ${kit.needsYouReason}` : "The ads kit isn't ready yet.");
  const parsed = AdsExportBody.safeParse(kit.body);
  if (!parsed.success) throw new AdsExportRefused("This ads kit is incomplete. Make it again.");
  const body = parsed.data;
  const [product] = await db.select().from(products).where(and(eq(products.id, kit.productId), eq(products.workspaceId, workspaceId)));
  if (!product) throw new AdsExportRefused("That project wasn't found.");

  const refIds = new Set<string>([
    ...body.concepts.flatMap((c) => [...c.visual.assetIds, ...c.visual.renderIds]),
    ...Object.values(body.platforms).flatMap((p) => p.creatives.map((c) => c.id)),
  ]);
  const ids = [...refIds].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const renderRows = ids.length
    ? await db.select({ id: renders.id, assetId: renders.outputAssetId }).from(renders).where(and(eq(renders.workspaceId, workspaceId), inArray(renders.id, ids)))
    : [];
  const renderAsset = new Map(renderRows.filter((r) => r.assetId).map((r) => [r.id, r.assetId!]));
  const assetIds = [...new Set([...ids.filter((id) => !renderAsset.has(id)), ...renderAsset.values()])];
  const assetRows = assetIds.length
    ? await db.select().from(assets).where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, assetIds)))
    : [];
  const assetById = new Map(assetRows.map((a) => [a.id, a]));
  const creatives: ResolvedCreative[] = [];
  for (const id of ids) {
    const a = assetById.get(renderAsset.get(id) ?? id);
    if (a) creatives.push({ refId: id, assetId: a.id, mime: a.mime });
  }

  const { files, media } = buildAdsExport(body, creatives, {
    productName: product.name,
    productSlug: product.slug,
    landingUrl: product.urls.website ?? null,
  });
  for (const m of media) {
    const a = assetById.get(m.assetId)!;
    files.push({ path: m.path, bytes: new Uint8Array(await storage.get(a.storageKey)) });
  }
  return files;
}
