import { and, eq, inArray } from "drizzle-orm";
import { KIT_LABELS, type LaunchKitBody } from "@mkt/contracts";
import { schema, type Db } from "@mkt/db";
import { adsExportFiles } from "../../ads/index.ts";
import type { Storage } from "../../media/storage.ts";
import { withUtm } from "../../publishing/links.ts";
import { zipStore, type ZipEntry } from "../../publishing/zip.ts";
import { storeAsset } from "../../video/store.ts";
import { assistedBody } from "./assisted.ts";
import { disclosuresOk, exportBlocker, validateKitBody } from "./checks.ts";
import { kitFor, kitInputsFor, loadKitContext } from "./context.ts";
import { storeKit } from "./run.ts";

const { assets, launchKits, products } = schema;

// "Download kit" (§8: the kit won't export without its disclosures): markdown files, plus the
// press kit's files, zipped and kept as an asset.

export interface KitFile {
  name: string;
  text: string;
}

export interface KitFileCtx {
  productName: string;
  site: string | null;
  campaign: string;
  launchDate: string;
}

/** {{link:landing}} → the website with tracking params for this kit (or "[your website]"). */
export function resolveKitLinks(text: string, ctx: KitFileCtx, source: string): string {
  let url: string | null = null;
  if (ctx.site) {
    try {
      url = withUtm(ctx.site, { utm_source: source, utm_medium: "launch_kit", utm_campaign: ctx.campaign });
    } catch {
      url = null;
    }
  }
  return text.replace(/\{\{\s*link:landing\s*\}\}/g, url ?? "[your website]");
}

const list = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join("\n");
const numbered = (xs: readonly string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
const pad = (n: number) => String(n).padStart(2, "0");

/** The markdown files of one kit (pure). */
export function kitFiles(body: LaunchKitBody, ctx: KitFileCtx): KitFile[] {
  const link = (s: string) => resolveKitLinks(s, ctx, body.kind);
  const readme = (lines: string[]): KitFile => ({
    name: "README.md",
    text: [`# ${ctx.productName}: ${KIT_LABELS[body.kind].toLowerCase()}`, "", `Launch day: ${ctx.launchDate}.`, "", ...lines, "", "Nothing in this kit is sent or posted for you. You send and post everything yourself.", ""].join("\n"),
  });
  switch (body.kind) {
    case "subreddit":
      return [
        readme([
          "One draft per community. Before you post each one:",
          "1. Open the community's rules and read them today.",
          '2. In the app, tick "I checked the rules today" on the task.',
          "3. Post it yourself. Never ask anyone to upvote it.",
        ]),
        ...body.drafts.map((d) => ({
          name: `posts/r-${d.subreddit.toLowerCase()}.md`,
          text: [
            `# r/${d.subreddit}`,
            d.checkNote ? `\n> ${d.checkNote}\n` : "",
            `Rules: ${d.rulesUrl}`,
            `Best time: ${d.bestTime}`,
            `Why it fits: ${d.whyThisFits}`,
            "",
            "## Title",
            d.title,
            "",
            "## Body",
            assistedBody(d.body, ctx.site, ctx.campaign, d.subreddit),
            "",
          ].join("\n"),
        })),
      ];
    case "ambassador":
      return [
        readme(["- pitch.md: how to explain the program", "- messages.md: 3 messages you send yourself", "- posting-guide.md: what ambassadors post, with the required disclosure", "- links.csv: one referral link per ambassador"]),
        { name: "pitch.md", text: `# The pitch\n\n${link(body.pitch)}\n\n## What ambassadors get\n\n${list(body.perks)}\n` },
        {
          name: "messages.md",
          text: `# Messages you send yourself\n\n${body.templates.map((t, i) => `## Message ${i + 1} (${t.channel === "email" ? "email" : "DM"})\n\n${t.subject ? `Subject: ${t.subject}\n\n` : ""}${link(t.text)}`).join("\n\n")}\n`,
        },
        {
          name: "posting-guide.md",
          text: [
            "# Posting guide",
            "",
            "## Always disclose (required)",
            "",
            `Start every caption with: **${body.disclosure.captionPrefix}**`,
            "",
            `In videos, say: "${body.disclosure.spokenLine}"`,
            "",
            list(body.disclosure.rules),
            "",
            "## TikTok: turn on branded content",
            "",
            numbered(body.brandedContentSteps),
            "",
            "## How to post",
            "",
            numbered(body.postingGuide.map(link)),
            "",
            "## Caption examples",
            "",
            body.captionExamples.map((c) => `> ${link(c)}`).join("\n\n"),
            "",
          ].join("\n"),
        },
        { name: "links.csv", text: ["name,ref,link", ...body.links.map((l) => [l.name, l.ref, l.url].map(csv).join(","))].join("\n") + "\n" },
      ];
    case "press":
      return [
        readme(["- fact-sheet.md", "- boilerplate.md", "- founder-quote.md (edit this: your words)", "- pitches/: 10 drafts. Fill in every [placeholder] before sending", "- assets/: logo, screenshots and stills"]),
        { name: "fact-sheet.md", text: `# ${ctx.productName} fact sheet\n\n| | |\n|---|---|\n${body.facts.map((f) => `| ${cell(f.label)} | ${cell(link(f.value))} |`).join("\n")}\n` },
        { name: "boilerplate.md", text: `# About ${ctx.productName}\n\n${link(body.boilerplate)}\n` },
        { name: "founder-quote.md", text: `# Founder quote\n\n> ${body.founderQuote.editMe ? `${body.founderQuote.note}\n\n> ` : ""}${body.founderQuote.text}\n` },
        ...body.pitches.map((p, i) => ({
          name: `pitches/${pad(i + 1)}-${slug(p.outletType)}.md`,
          text: `# Pitch ${i + 1}: ${p.outlet}\n\nSubject: ${p.subject}\n\n${link(p.body)}\n`,
        })),
        { name: "assets.md", text: `# Files\n\n${body.assets.map((a, i) => `- assets/${assetFileName(i, a.label, "")}: ${a.label} (${a.kind})`).join("\n") || "No files yet."}\n` },
      ];
    case "creator":
      return [
        readme(["- creator-brief.md: what it is, what to show, dos and don'ts, disclosure", "- messages.md: 3 messages you send yourself"]),
        {
          name: "creator-brief.md",
          text: [
            `# ${ctx.productName}: creator brief`,
            "",
            link(body.whatItIs),
            "",
            "## What to show",
            list(body.whatToShow),
            "",
            "## Do",
            list(body.dos),
            "",
            "## Don't",
            list(body.donts),
            "",
            "## Disclosure (required)",
            "",
            `Start the caption with: **${body.disclosure.captionPrefix}**`,
            "",
            `Say near the start: "${body.disclosure.spokenLine}"`,
            "",
            list(body.disclosure.rules),
            "",
            "## TikTok: turn on branded content",
            "",
            numbered(body.brandedContentSteps),
            "",
          ].join("\n"),
        },
        { name: "messages.md", text: `# Messages you send yourself\n\n${body.dmTemplates.map((t, i) => `## Message ${i + 1}\n\n${link(t.text)}`).join("\n\n")}\n` },
      ];
    case "reply_bank":
      return [
        readme(["- reply-bank.md: ready replies for launch day. Reword them to fit each comment."]),
        { name: "reply-bank.md", text: `# Reply bank\n\n${body.replies.map((r) => `## ${r.trigger}\n\n${link(r.reply)}`).join("\n\n")}\n` },
      ];
  }
}

const csv = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const assetFileName = (i: number, label: string, ext: string) => `${pad(i + 1)}-${slug(label)}${ext ? `.${ext}` : ""}`;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "video/mp4": "mp4", "application/pdf": "pdf" };

export interface ExportDeps {
  db: Db;
  storage: Storage;
}

export interface ExportedKit {
  assetId: string;
  fileName: string;
  files: string[];
}

/**
 * Build the kit's zip and keep it as an asset (launch_kits.export_asset_id). Re-checks first (facts
 * may have expired since): refuses with a plain sentence unless every disclosure is in place and
 * nothing blocks. Stored as kind "pdf" with mime application/zip until assets gain a "file" kind.
 */
export async function exportKit(deps: ExportDeps, workspaceId: string, kitId: string, now = new Date()): Promise<ExportedKit> {
  const { db } = deps;
  const kit = await kitFor(db, workspaceId, kitId);
  if (!kit) throw new Error("That kit doesn't exist.");
  if (kit.kind === "ads_export") return exportAdsKit(deps, workspaceId, kit.id, kit.productId, now);
  if (!kit.body) throw new Error("There's nothing to download yet. Make the kit first.");
  const early = exportBlocker(kit.kind, kit.status, kit.issues, kit.disclosuresOk);
  if (early) throw new Error(early);

  const inputs = await kitInputsFor(db, kit);
  const ctx = await loadKitContext(db, kit, inputs, now);
  const body = kit.body as unknown as LaunchKitBody;
  const issues = [...kit.issues.filter((i) => i.code === "raw_link_removed"), ...validateKitBody(body, ctx.check)];
  const blocked = exportBlocker(kit.kind, kit.status, issues, disclosuresOk(issues));
  if (blocked) {
    await storeKit(db, kit.id, body, issues, now);
    throw new Error(blocked);
  }

  const fileCtx: KitFileCtx = { productName: ctx.build.productName, site: ctx.build.site, campaign: ctx.build.campaign, launchDate: ctx.plan.launchDate };
  const enc = new TextEncoder();
  const entries: ZipEntry[] = kitFiles(body, fileCtx).map((f) => ({ name: f.name, data: enc.encode(f.text) }));
  if (body.kind === "press" && body.assets.length) {
    const rows = await db.select().from(assets).where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, body.assets.map((a) => a.assetId))));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [i, a] of body.assets.entries()) {
      const row = byId.get(a.assetId);
      if (!row) continue;
      try {
        const bytes = await deps.storage.get(row.storageKey);
        entries.push({ name: `assets/${assetFileName(i, a.label, EXT[row.mime] ?? "bin")}`, data: new Uint8Array(bytes) });
      } catch {
        throw new Error(`The file "${a.label}" is missing from storage. Remove it from the press kit, then download again.`);
      }
    }
  }
  const stored = await storeKitZip(deps, workspaceId, kit, entries);
  await db.update(launchKits).set({ exportAssetId: stored.id, updatedAt: now }).where(eq(launchKits.id, kit.id));
  return { assetId: stored.id, fileName: `${slug(ctx.build.productName)}-${kit.kind.replace("_", "-")}-kit.zip`, files: entries.map((e) => e.name) };
}

/** The ads kit's files come from the ads module (throws AdsExportRefused with a plain sentence). */
async function exportAdsKit(deps: ExportDeps, workspaceId: string, kitId: string, productId: string, now: Date): Promise<ExportedKit> {
  const files = await adsExportFiles(deps.db, deps.storage, workspaceId, kitId);
  const entries: ZipEntry[] = files.map((f) => ({ name: f.path, data: f.bytes }));
  const stored = await storeKitZip(deps, workspaceId, { id: kitId, kind: "ads_export", productId }, entries);
  await deps.db.update(launchKits).set({ exportAssetId: stored.id, updatedAt: now }).where(eq(launchKits.id, kitId));
  const [product] = await deps.db.select({ name: products.name }).from(products).where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  return { assetId: stored.id, fileName: `${slug(product?.name ?? "launch")}-ads-kit.zip`, files: entries.map((e) => e.name) };
}

async function storeKitZip(deps: ExportDeps, workspaceId: string, kit: { id: string; kind: keyof typeof KIT_LABELS; productId: string }, entries: ZipEntry[]) {
  const zip = zipStore(entries);
  return storeAsset(deps.db, deps.storage, {
    workspaceId,
    productId: kit.productId,
    kind: "pdf",
    origin: "generated",
    tier: "A",
    mime: "application/zip",
    ext: "zip",
    bytes: zip,
    labels: { launchKitExport: true, usefulForMarketing: false, kitId: kit.id, kitKind: kit.kind, caption: `${KIT_LABELS[kit.kind]} (download)` },
    origination: { launchKitId: kit.id },
  });
}
