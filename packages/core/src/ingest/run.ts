import { and, eq, inArray, isNull } from "drizzle-orm";
import { IntakeInput, type RunEvent } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { sha256, workspacePrefix } from "../media/storage.ts";
import { budgetScopesForRun, describeFailure, runSpentMicros } from "../runs/summary.ts";
import { classifyInput, linkedSources, githubRepoUrl, parseGithubRepo, sameSite, slugify } from "./classify.ts";
import { InvalidUpload } from "./folder.ts";
import { fetchGithubRepo, GithubUnavailable, repoMetaText } from "./github.ts";
import { loadEvidence, writeProfile } from "./profile.ts";
import { gapQuestions, labelScreenshot, research, type CallCtx } from "./steps.ts";
import type { IngestDeps, SiteCapture } from "./types.ts";

const { generationRuns, products, sources, sourceArtifacts, assets, folderUploads, researchItems, dnaGapQuestions } = schema;

/** §7.2: an ingest run is capped at $1.50. */
export const INGEST_RUN_CAP_MICROS = 1_500_000;
export const STRATEGY_RUN_CAP_MICROS = 1_500_000;
const MAX_LABELED = 12;
const LABEL_CONCURRENCY = 4;

export interface CreatedIngest {
  runId: string;
  productId: string;
  slug: string;
}

/**
 * The drop zone's "Read my product": classify the links, find or create the product, record one
 * source row per input (visibility decided here), and queue the run. Nothing is fetched yet.
 */
export async function createIngestRun(db: Db, workspaceId: string, raw: unknown): Promise<CreatedIngest> {
  const input = IntakeInput.parse(raw);
  const classified = input.links.map(classifyInput);
  const websites = classified.flatMap((c) => (c.kind === "website" ? [c.url] : []));
  const repos = classified.flatMap((c) => (c.kind === "github" ? [c] : []));
  const notes = [
    ...classified.flatMap((c) => (c.kind === "notes" ? [c.text] : [])),
    ...(input.notes?.trim() ? [input.notes.trim()] : []),
  ].join("\n\n");

  let folder: typeof folderUploads.$inferSelect | undefined;
  if (input.folderUploadId) {
    [folder] = await db
      .select()
      .from(folderUploads)
      .where(and(eq(folderUploads.id, input.folderUploadId), eq(folderUploads.workspaceId, workspaceId)));
    if (!folder) throw new InvalidUpload("That folder upload wasn't found. Drop the folder again.");
  }
  if (!websites.length && !repos.length && !folder && !notes) {
    throw new InvalidUpload("Add a link, a project folder or a few notes first.");
  }

  const website = websites[0] ?? null;
  const repo = repos[0] ?? (folder?.gitRemote ? parseGithubRepo(folder.gitRemote) : null);
  const guessName = website
    ? new URL(website).hostname.replace(/^www\./, "").split(".")[0]!
    : repo
      ? repo.repo
      : folder
        ? folder.rootName
        : "My product";

  // Same website host → same product, so a second paste doesn't fork the history.
  const existing = await db.select().from(products).where(eq(products.workspaceId, workspaceId));
  let product = website ? existing.find((p) => p.urls.website && sameSite(p.urls.website, website)) : undefined;
  if (!product && repo) {
    product = existing.find((p) => p.urls.repo && p.urls.repo.toLowerCase() === githubRepoUrl(repo.owner, repo.repo).toLowerCase());
  }
  const productId = product?.id ?? uuidv7();
  const slug = product?.slug ?? slugify(guessName, new Set(existing.map((p) => p.slug)));
  const runId = uuidv7();

  await db.transaction(async (tx) => {
    if (!product) {
      await tx.insert(products).values({
        id: productId,
        workspaceId,
        slug,
        name: guessName,
        urls: { ...(website ? { website } : {}), ...(repo ? { repo: githubRepoUrl(repo.owner, repo.repo) } : {}) },
      });
    }
    const rows: (typeof sources.$inferInsert)[] = [];
    for (const url of websites) rows.push({ id: uuidv7(), workspaceId, productId, runId, kind: "website", url, visibility: "public_ok" });
    for (const r of repos) {
      rows.push({ id: uuidv7(), workspaceId, productId, runId, kind: "github", url: r.url, visibility: "public_ok", meta: { owner: r.owner, repo: r.repo } });
    }
    if (folder) {
      rows.push({
        id: uuidv7(),
        workspaceId,
        productId,
        runId,
        kind: "folder_upload",
        visibility: "internal",
        secretScanHits: folder.secretHits,
        meta: { folderUploadId: folder.id, rootName: folder.rootName, gitRemote: folder.gitRemote },
      });
    }
    if (notes) rows.push({ id: uuidv7(), workspaceId, productId, runId, kind: "text", visibility: "internal", meta: { text: notes.slice(0, 20_000) } });
    await tx.insert(sources).values(rows);
    await tx.insert(generationRuns).values({
      id: runId,
      workspaceId,
      productId,
      kind: "ingest",
      status: "queued",
      input: { ...input, slug },
      capMicros: INGEST_RUN_CAP_MICROS,
    });
  });
  return { runId, productId, slug };
}

type Publish = (e: RunEvent) => Promise<unknown>;

async function stage<T>(publish: Publish, id: string, label: string, fn: () => Promise<T>): Promise<T> {
  await publish({ type: "stage_started", stage: id, label });
  const out = await fn();
  await publish({ type: "stage_done", stage: id });
  return out;
}

/** Soft failure: warn, mark the source, keep going (a private repo shouldn't end the run). */
async function soft(publish: Publish, stageId: string, fn: () => Promise<void>, onFail?: (msg: string) => PromiseLike<unknown>) {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof GithubUnavailable || (err instanceof Error && "code" in err && err.code === "blocked_url")
      ? err.message
      : "We couldn't read this one. The run continues without it.";
    await onFail?.(err instanceof Error ? err.message : String(err));
    await publish({ type: "stage_warning", stage: stageId, message: msg });
  }
}

/**
 * The M1 ingest pipeline (§5.2): sources → screenshots labeled → gap questions (non-blocking) →
 * research → evidence bundle → 3 section syntheses → merged DNA + claims. Queues the strategy run.
 */
export async function executeIngestRun(
  deps: IngestDeps & { enqueueStrategy: (runId: string) => Promise<void> },
  runId: string,
): Promise<void> {
  const { db, publish } = deps;
  const now = deps.now ?? (() => new Date());
  const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, runId));
  if (!run || run.status !== "queued" || !run.productId) return;
  const [product] = await db.select().from(products).where(eq(products.id, run.productId));
  if (!product) return;
  await db.update(generationRuns).set({ status: "running", startedAt: now() }).where(eq(generationRuns.id, runId));

  let current = "sources";
  try {
    const budgetPeriodIds = await budgetScopesForRun(db, run.workspaceId, runId, run.capMicros);
    const ctx: CallCtx = { ai: { db, rates: deps.rates, client: deps.client }, workspaceId: run.workspaceId, budgetPeriodIds, runId };
    const ws = run.workspaceId;
    const srcs = await db.select().from(sources).where(eq(sources.runId, runId));
    const addArtifact = (sourceId: string, a: Omit<typeof sourceArtifacts.$inferInsert, "id" | "workspaceId" | "sourceId">) =>
      db.insert(sourceArtifacts).values({ id: uuidv7(), workspaceId: ws, sourceId, ...a });
    const setSource = (id: string, patch: Partial<typeof sources.$inferInsert>) => db.update(sources).set(patch).where(eq(sources.id, id));

    // ── repo + folder first: they can point at the website ──
    current = "repo";
    const repoSources = srcs.filter((s) => s.kind === "github");
    const folderSource = srcs.find((s) => s.kind === "folder_upload");
    let discoveredWebsite: string | null = null;
    if (repoSources.length || folderSource) {
      await stage(publish, "repo", "Project folder / Repo", async () => {
        if (folderSource) {
          await soft(publish, "repo", async () => {
            const hints = await readFolder(deps, folderSource, addArtifact);
            const linked = linkedSources(hints);
            discoveredWebsite ??= linked.website;
            if (linked.repo && !repoSources.length) {
              const id = uuidv7();
              const url = githubRepoUrl(linked.repo.owner, linked.repo.repo);
              await db.insert(sources).values({
                id, workspaceId: ws, productId: product.id, runId, kind: "github", url, visibility: "public_ok",
                parentSourceId: folderSource.id, meta: { owner: linked.repo.owner, repo: linked.repo.repo },
              });
              repoSources.push((await db.select().from(sources).where(eq(sources.id, id)))[0]!);
            }
            await setSource(folderSource.id, { status: "fetched" });
          }, (e) => setSource(folderSource.id, { status: "failed", error: e.slice(0, 500) }));
        }
        for (const s of repoSources) {
          await soft(publish, "repo", async () => {
            const { owner, repo } = s.meta as { owner: string; repo: string };
            const data = await fetchGithubRepo(deps.fetchText, owner, repo, deps.githubToken);
            await addArtifact(s.id, { kind: "repo_meta", title: data.fullName, url: s.url, text: repoMetaText(data) });
            if (data.readme) await addArtifact(s.id, { kind: "readme", title: `${data.fullName} README`, url: s.url, path: "README.md", text: data.readme });
            await setSource(s.id, { status: "fetched", secretScanHits: data.secretHits, contentHash: sha256(data.readme ?? "") });
            await publish({ type: "fact_found", text: `Read the ${data.fullName} repo${data.stars ? ` (${data.stars} stars)` : ""}` });
            discoveredWebsite ??= linkedSources({ homepage: data.homepage }).website;
          }, (e) => setSource(s.id, { status: "failed", error: e.slice(0, 500) }));
        }
      });
    } else {
      await publish({ type: "stage_skipped", stage: "repo", reason: "No repo or folder" });
    }

    // ── website ──
    current = "website";
    const siteSources = srcs.filter((s) => s.kind === "website");
    if (!siteSources.length && discoveredWebsite) {
      const id = uuidv7();
      await db.insert(sources).values({
        id, workspaceId: ws, productId: product.id, runId, kind: "website", url: discoveredWebsite, visibility: "public_ok",
        parentSourceId: repoSources[0]?.id ?? folderSource?.id ?? null,
      });
      siteSources.push((await db.select().from(sources).where(eq(sources.id, id)))[0]!);
      if (!product.urls.website) await db.update(products).set({ urls: { ...product.urls, website: discoveredWebsite } }).where(eq(products.id, product.id));
    }
    if (siteSources.length) {
      await stage(publish, "website", "Website", async () => {
        for (const s of siteSources.slice(0, 2)) {
          await soft(publish, "website", async () => {
            await publish({ type: "stage_progress", stage: "website", message: `Opening ${s.url}` });
            const site = await deps.captureSite(s.url!);
            await saveSite(deps, product.id, s.id, site, addArtifact);
            await setSource(s.id, { status: "fetched", contentHash: sha256(site.pages.map((p) => p.markdown).join("\n")), meta: { ...s.meta, finalUrl: site.finalUrl, brand: site.brand } });
          }, (e) => setSource(s.id, { status: "failed", error: e.slice(0, 500) }));
        }
      });
    } else {
      await publish({ type: "stage_skipped", stage: "website", reason: "No website" });
    }

    // ── notes ──
    current = "notes";
    const noteSource = srcs.find((s) => s.kind === "text");
    if (noteSource) {
      await stage(publish, "notes", "Your notes", async () => {
        await addArtifact(noteSource.id, { kind: "notes", title: "Your notes", text: String((noteSource.meta as { text?: string }).text ?? "") });
        await setSource(noteSource.id, { status: "fetched" });
      });
    }

    const fetchedAny = (await loadEvidence(db, product.id, runId, product.name)).markdown.includes("<source_text>");
    if (!fetchedAny) {
      throw new NothingToRead();
    }

    // ── screenshots ──
    current = "screens";
    await stage(publish, "screens", "Looking at screenshots", async () => {
      const unlabeled = (await db.select().from(assets).where(and(eq(assets.productId, product.id), isNull(assets.labels)))).slice(0, MAX_LABELED);
      for (let i = 0; i < unlabeled.length; i += LABEL_CONCURRENCY) {
        await Promise.all(
          unlabeled.slice(i, i + LABEL_CONCURRENCY).map((a) =>
            soft(publish, "screens", async () => {
              const previewKey = typeof a.origination.previewKey === "string" ? a.origination.previewKey : null;
              if (!previewKey) return; // uploaded images get labeled once M3a adds resizing
              const label = await labelScreenshot(ctx, {
                jpeg: await deps.storage.get(previewKey),
                pageUrl: String(a.origination.pageUrl ?? ""),
                viewport: String(a.origination.viewport ?? "desktop"),
              });
              await db.update(assets).set({ labels: label, piiHits: label.hasPersonalData }).where(eq(assets.id, a.id));
              await publish({ type: "asset_found", assetId: a.id, caption: label.caption });
            }),
          ),
        );
      }
    });

    // ── gap questions: asked now, answers used if they arrive before the profile is written ──
    current = "questions";
    const askedAt = now();
    await stage(publish, "questions", "A few questions", async () => {
      await soft(publish, "questions", async () => {
        const early = await loadEvidence(db, product.id, runId, product.name);
        const qs = await gapQuestions(ctx, early.markdown);
        for (const q of qs) {
          const id = uuidv7();
          await db.insert(dnaGapQuestions).values({ id, workspaceId: ws, productId: product.id, runId, path: q.path, question: q.question, why: q.why, options: q.options });
          await publish({ type: "question_ready", questionId: id, question: q.question, options: q.options });
        }
      });
    });

    // ── research ──
    current = "research";
    await stage(publish, "research", "Similar products and what people complain about", async () => {
      await soft(publish, "research", async () => {
        const brief = (await loadEvidence(db, product.id, runId, product.name)).markdown.slice(0, 24_000);
        const save = (kind: "finding" | "competitor" | "pain", data: Record<string, unknown>, sourceUrl: string | null) =>
          db.insert(researchItems).values({ id: uuidv7(), workspaceId: ws, productId: product.id, runId, kind, data, sourceUrl });
        const out = await research(ctx, {
          productBrief: brief,
          fetchText: deps.fetchText,
          sink: {
            finding: async (f) => void (await publish({ type: "fact_found", text: f.text.slice(0, 300) })),
            competitor: async (c) => void (await publish({ type: "competitor_found", name: c.name, url: c.url })),
            pain: async (p) => void (await publish({ type: "quote_found", text: p.text.slice(0, 300), url: p.sourceUrl })),
          },
        });
        // Only the deduplicated summary is stored, so the bundle doesn't carry near-duplicates.
        for (const f of out.findings) await save("finding", f, f.sourceUrl);
        for (const c of out.competitors) await save("competitor", c, c.sourceUrl);
        for (const p of out.pains) await save("pain", p, p.sourceUrl);
      });
    });

    // ── profile ──
    current = "profile";
    const profile = await stage(publish, "profile", "Writing your profile", async () => {
      await waitForAnswers(db, runId, askedAt, deps.answerWaitMs ?? 45_000, publish);
      return writeProfile(db, deps.storage, ctx, { id: product.id, name: product.name, workspaceId: ws }, runId, now(), (s) =>
        publish({ type: "stage_progress", stage: "profile", message: `Wrote the ${s} section` }),
      );
    });
    if (product.name !== profile.dna.identity.name && profile.dna.identity.name.trim()) {
      await db.update(products).set({ name: profile.dna.identity.name.trim().slice(0, 120) }).where(eq(products.id, product.id));
    }

    const spent = await runSpentMicros(db, runId);
    await publish({ type: "cost_update", spentMicros: spent });
    await db
      .update(generationRuns)
      .set({ status: "completed", result: { ...profile, dna: undefined, spentMicros: spent }, finishedAt: now() })
      .where(eq(generationRuns.id, runId));
    await publish({ type: "artifact_ready", kind: "dna", id: profile.dnaVersionId });

    const strategyRunId = await createStrategyRun(db, ws, product.id, profile.dnaVersionId);
    await deps.enqueueStrategy(strategyRunId);
    await publish({ type: "artifact_ready", kind: "strategy_run", id: strategyRunId });
    await publish({ type: "run_completed" });
  } catch (err) {
    const { code, message, retryable } = err instanceof NothingToRead ? { code: err.code, message: err.message, retryable: true } : describeFailure(err);
    await db
      .update(generationRuns)
      .set({ status: "failed", error: `${code}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2_000), finishedAt: now() })
      .where(eq(generationRuns.id, runId));
    await publish({ type: "stage_failed", stage: current, code, message, retryable });
  }
}

class NothingToRead extends Error {
  readonly code = "nothing_to_read";
  constructor() {
    super("We couldn't read anything from what you dropped in. Check the link, or add the project folder or a few notes.");
  }
}

export async function createStrategyRun(db: Db, workspaceId: string, productId: string, dnaVersionId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(generationRuns).values({
    id,
    workspaceId,
    productId,
    kind: "strategy",
    status: "queued",
    input: { dnaVersionId },
    capMicros: STRATEGY_RUN_CAP_MICROS,
  });
  return id;
}

/** Give open questions a little time; never block past the deadline (§2.3: questions don't block). */
async function waitForAnswers(db: Db, runId: string, askedAt: Date, maxMs: number, publish: Publish): Promise<void> {
  const deadline = askedAt.getTime() + maxMs;
  let told = false;
  for (;;) {
    const open = await db
      .select({ id: dnaGapQuestions.id })
      .from(dnaGapQuestions)
      .where(and(eq(dnaGapQuestions.runId, runId), isNull(dnaGapQuestions.answeredAt)));
    if (!open.length || Date.now() >= deadline) return;
    if (!told) {
      told = true;
      await publish({ type: "stage_progress", stage: "profile", message: "Waiting a moment for your answers (you can skip them)" });
    }
    await new Promise((r) => setTimeout(r, Math.min(3_000, Math.max(0, deadline - Date.now()))));
  }
}

async function readFolder(
  deps: IngestDeps,
  s: typeof sources.$inferSelect,
  addArtifact: (sourceId: string, a: Omit<typeof sourceArtifacts.$inferInsert, "id" | "workspaceId" | "sourceId">) => Promise<unknown>,
): Promise<Parameters<typeof linkedSources>[0]> {
  const { folderUploadId } = s.meta as { folderUploadId: string };
  const [up] = await deps.db.select().from(folderUploads).where(eq(folderUploads.id, folderUploadId));
  if (!up) throw new Error("folder upload missing");
  let packageJson: { homepage?: unknown; repository?: unknown } | null = null;
  let images = 0;
  for (const f of up.files) {
    const body = await deps.storage.get(f.storageKey);
    if (f.kind === "image") {
      const hash = sha256(body);
      await deps.db
        .insert(assets)
        .values({
          id: uuidv7(), workspaceId: s.workspaceId, productId: s.productId, sourceId: s.id, kind: "image", origin: "uploaded",
          mime: mimeFromKey(f.storageKey), sha256: hash, storageKey: f.storageKey, origination: { path: f.path },
        })
        .onConflictDoNothing();
      images++;
      continue;
    }
    const text = body.toString("utf-8");
    const kind = f.kind === "readme" ? "readme" : f.kind === "package_json" || f.kind === "app_json" ? "package_json" : "doc";
    if (f.kind === "package_json") {
      try {
        packageJson = JSON.parse(text) as typeof packageJson;
      } catch {
        // a broken package.json is still useful text
      }
    }
    await addArtifact(s.id, { kind, title: f.path, path: f.path, text: kind === "package_json" ? packageFacts(text) : text });
  }
  await deps.publish({
    type: "fact_found",
    text: `Read ${up.files.length - images} files${images ? ` and ${images} images` : ""} from ${up.rootName}${up.secretHits ? ` (hid ${up.secretHits} secret${up.secretHits === 1 ? "" : "s"})` : ""}`,
  });
  return { gitRemote: up.gitRemote, packageJson };
}

/** package.json → the handful of fields that describe the product (never scripts or config). */
export function packageFacts(text: string): string {
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    const pick = ["name", "displayName", "description", "homepage", "keywords", "license", "version", "author", "repository", "engines", "bin"];
    const deps = Object.keys({ ...(p.dependencies as object), ...(p.devDependencies as object) }).slice(0, 40);
    const out: Record<string, unknown> = {};
    for (const k of pick) if (p[k] !== undefined) out[k] = p[k];
    if (deps.length) out.dependencies = deps;
    const expo = p.expo as Record<string, unknown> | undefined;
    if (expo) for (const k of ["name", "slug", "description", "platforms"]) if (expo[k] !== undefined) out[`expo.${k}`] = expo[k];
    return JSON.stringify(out, null, 2);
  } catch {
    return text.slice(0, 4_000);
  }
}

function mimeFromKey(key: string): string {
  const ext = key.split(".").pop();
  return ext === "jpeg" || ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

async function saveSite(
  deps: IngestDeps,
  productId: string,
  sourceId: string,
  site: SiteCapture,
  addArtifact: (sourceId: string, a: Omit<typeof sourceArtifacts.$inferInsert, "id" | "workspaceId" | "sourceId">) => Promise<unknown>,
): Promise<void> {
  const [src] = await deps.db.select().from(sources).where(eq(sources.id, sourceId));
  const ws = src!.workspaceId;
  for (const p of [...site.pages].sort((a, b) => a.rank - b.rank)) {
    await addArtifact(sourceId, { kind: "page", title: p.title, url: p.url, text: p.markdown, meta: { rank: p.rank } });
  }
  await addArtifact(sourceId, { kind: "brand", title: "Brand", url: site.finalUrl, text: JSON.stringify(site.brand), meta: { ...site.brand } });
  await deps.publish({ type: "fact_found", text: `Read ${site.pages.length} page${site.pages.length === 1 ? "" : "s"} on ${new URL(site.finalUrl).hostname}` });

  const prefix = `${workspacePrefix(ws)}/assets`;
  for (const shot of site.screenshots) {
    const hash = sha256(shot.png);
    const key = `${prefix}/${hash}.png`;
    const previewKey = `${prefix}/${hash}-preview.jpg`;
    await deps.storage.put(key, shot.png);
    await deps.storage.put(previewKey, shot.preview);
    const [row] = await deps.db
      .insert(assets)
      .values({
        id: uuidv7(), workspaceId: ws, productId, sourceId, kind: "screenshot", origin: "captured", mime: "image/png",
        width: shot.width, height: shot.height, sha256: hash, storageKey: key,
        origination: { pageUrl: shot.pageUrl, viewport: shot.viewport, previewKey },
      })
      .onConflictDoNothing()
      .returning({ id: assets.id });
    if (row) await deps.publish({ type: "asset_found", assetId: row.id, caption: null });
  }
}

/** Answer (or skip) a gap question from the run screen. Workspace-scoped. */
export async function answerGapQuestion(db: Db, workspaceId: string, questionId: string, answer: string | null): Promise<boolean> {
  const res = await db
    .update(dnaGapQuestions)
    .set({ answer: answer?.trim().slice(0, 2_000) || null, skipped: !answer?.trim(), answeredAt: new Date() })
    .where(and(eq(dnaGapQuestions.id, questionId), eq(dnaGapQuestions.workspaceId, workspaceId)))
    .returning({ id: dnaGapQuestions.id });
  return res.length > 0;
}

export async function questionsForRun(db: Db, workspaceId: string, runIds: string[]) {
  if (!runIds.length) return [];
  return db
    .select()
    .from(dnaGapQuestions)
    .where(and(eq(dnaGapQuestions.workspaceId, workspaceId), inArray(dnaGapQuestions.runId, runIds)))
    .orderBy(dnaGapQuestions.createdAt);
}

