import { and, desc, eq, ne } from "drizzle-orm";
import type { FieldMetaMap, ProductDna, StrategyOutput } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { budgetScopesForRun, describeFailure, runSpentMicros } from "../runs/summary.ts";
import { editField, unsureItems } from "./merge-evidence.ts";
import { claimsFor, writeProfile } from "./profile.ts";
import { createStrategyRun, INGEST_RUN_CAP_MICROS } from "./run.ts";
import { latestStrategy } from "./strategy.ts";
import type { IngestDeps } from "./types.ts";

const { productDnaVersions, generationRuns, products, sources, claims } = schema;

export async function currentDna(db: Db, productId: string) {
  const [v] = await db
    .select()
    .from(productDnaVersions)
    .where(eq(productDnaVersions.productId, productId))
    .orderBy(desc(productDnaVersions.version))
    .limit(1);
  if (!v) return null;
  return { ...v, dna: v.dna as unknown as ProductDna, fields: v.fields as unknown as FieldMetaMap };
}

/** "These look right": this version becomes the confirmed one; any earlier confirmed version is superseded. */
export async function confirmDna(db: Db, workspaceId: string, dnaVersionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [v] = await tx
      .select()
      .from(productDnaVersions)
      .where(and(eq(productDnaVersions.id, dnaVersionId), eq(productDnaVersions.workspaceId, workspaceId)));
    if (!v) return false;
    await tx
      .update(productDnaVersions)
      .set({ status: "superseded" })
      .where(and(eq(productDnaVersions.productId, v.productId), eq(productDnaVersions.status, "confirmed"), ne(productDnaVersions.id, v.id)));
    await tx.update(productDnaVersions).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(productDnaVersions.id, v.id));
    return true;
  });
}

/**
 * Inline fix or "Wrong?" from the plan screen (UI session only, §8). The field becomes the user's and
 * is pinned. An edited price or proof field doesn't rewrite claims: claims are rebuilt on regenerate.
 */
export async function editDnaField(
  db: Db,
  workspaceId: string,
  dnaVersionId: string,
  path: string,
  value: unknown,
): Promise<boolean> {
  const [v] = await db
    .select()
    .from(productDnaVersions)
    .where(and(eq(productDnaVersions.id, dnaVersionId), eq(productDnaVersions.workspaceId, workspaceId)));
  if (!v) return false;
  const next = editField(v.dna as unknown as ProductDna, v.fields as unknown as FieldMetaMap, path, value);
  await db
    .update(productDnaVersions)
    .set({ dna: next.dna as unknown as Record<string, unknown>, fields: next.fields })
    .where(eq(productDnaVersions.id, v.id));
  return true;
}

/** Pin or unpin a field without changing its value. */
export async function setPinned(db: Db, workspaceId: string, dnaVersionId: string, path: string, pinned: boolean): Promise<boolean> {
  const [v] = await db
    .select()
    .from(productDnaVersions)
    .where(and(eq(productDnaVersions.id, dnaVersionId), eq(productDnaVersions.workspaceId, workspaceId)));
  const fields = v?.fields as unknown as FieldMetaMap | undefined;
  if (!v || !fields?.[path]) return false;
  await db
    .update(productDnaVersions)
    .set({ fields: { ...fields, [path]: { ...fields[path]!, pinned } } })
    .where(eq(productDnaVersions.id, v.id));
  return true;
}

/** "Regenerate profile": re-synthesize from the same sources; pinned fields are kept. */
export async function createRegenerateRun(db: Db, workspaceId: string, productId: string): Promise<string | null> {
  const current = await currentDna(db, productId);
  if (!current || current.workspaceId !== workspaceId || !current.runId) return null;
  const id = uuidv7();
  await db.insert(generationRuns).values({
    id,
    workspaceId,
    productId,
    kind: "dna_regenerate",
    status: "queued",
    input: { ingestRunId: current.runId, fromVersion: current.version },
    capMicros: INGEST_RUN_CAP_MICROS,
  });
  return id;
}

export async function executeRegenerateRun(
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
  try {
    await publish({ type: "stage_started", stage: "profile", label: "Writing your profile" });
    const periods = await budgetScopesForRun(db, run.workspaceId, runId, run.capMicros);
    const profile = await writeProfile(
      db,
      deps.storage,
      { ai: { db, rates: deps.rates, client: deps.client }, workspaceId: run.workspaceId, budgetPeriodIds: periods, runId },
      { id: product.id, name: product.name, workspaceId: run.workspaceId },
      String(run.input.ingestRunId),
      now(),
    );
    await publish({ type: "stage_done", stage: "profile" });
    const spent = await runSpentMicros(db, runId);
    await db
      .update(generationRuns)
      .set({ status: "completed", result: { ...profile, dna: undefined, spentMicros: spent }, finishedAt: now() })
      .where(eq(generationRuns.id, runId));
    await publish({ type: "cost_update", spentMicros: spent });
    await publish({ type: "artifact_ready", kind: "dna", id: profile.dnaVersionId });
    const strategyRunId = await createStrategyRun(db, run.workspaceId, product.id, profile.dnaVersionId);
    await deps.enqueueStrategy(strategyRunId);
    await publish({ type: "artifact_ready", kind: "strategy_run", id: strategyRunId });
    await publish({ type: "run_completed" });
  } catch (err) {
    const { code, message, retryable } = describeFailure(err);
    await db
      .update(generationRuns)
      .set({ status: "failed", error: `${code}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2_000), finishedAt: now() })
      .where(eq(generationRuns.id, runId));
    await publish({ type: "stage_failed", stage: "profile", code, message, retryable });
  }
}

/** Everything the "Here's your plan" screen needs, workspace-scoped by the product lookup. */
export async function planView(db: Db, product: typeof products.$inferSelect) {
  const dna = await currentDna(db, product.id);
  const strategy = await latestStrategy(db, product.id);
  const productSources = await db.select().from(sources).where(eq(sources.productId, product.id));
  const runs = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.productId, product.id))
    .orderBy(desc(generationRuns.createdAt))
    .limit(5);
  return {
    product,
    dna,
    claims: dna ? await claimsFor(db, dna.id) : [],
    unsure: dna ? unsureItems(dna.fields) : [],
    strategy,
    strategyIsStale: !!(strategy && dna && strategy.dnaVersionId !== dna.id),
    sources: productSources,
    runs,
  };
}

/** Markdown brief export (§5.3): profile + angles + messaging, with public claims only. */
export function briefMarkdown(input: {
  productName: string;
  dna: ProductDna;
  strategy: StrategyOutput | null;
  launchDate: string | null;
  publicClaims: { ref: string; text: string }[];
}): string {
  const { dna, strategy } = input;
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const out: string[] = [
    `# ${input.productName}: marketing brief`,
    "",
    `> ${dna.identity.oneLiner}`,
    "",
    "## Who it's for",
    dna.identity.whoItsFor,
    "",
    ...dna.identity.audiences.flatMap((a) => [`**${a.name}**: ${a.description}`, list(a.painPoints), ""]),
    "## What they're trying to get done",
    list(dna.identity.jobs),
    "",
    "## Features",
    list(dna.offer.features.map((f) => `**${f.name}**: ${f.description}`)),
    "",
    "## Pricing",
    dna.offer.pricing.summary,
    list(dna.offer.pricing.tiers.map((t) => `${t.name}: ${t.price}${t.period ? ` ${t.period}` : ""}`)),
    "",
    "## Facts you can use in public",
    input.publicClaims.length ? list(input.publicClaims.map((c) => `${c.text} (${c.ref})`)) : "_None yet._",
    "",
    "## Competitors",
    list(dna.market.competitors.map((c) => `**${c.name}**${c.url ? ` (${c.url})` : ""}: ${c.howTheyDiffer}`)),
    "",
    "## What people complain about",
    list(dna.market.pains.map((p) => p.text)),
    "",
    "## Busy seasons",
    dna.market.seasonality.summary,
    list(dna.market.seasonality.peaks.map((p) => `${p.months}: ${p.reason}`)),
    "",
  ];
  if (strategy) {
    out.push("## Your angles", "");
    strategy.angles.forEach((a, i) => {
      out.push(
        `### ${i + 1}. ${a.title}`,
        `- **For:** ${a.forWho}`,
        `- **Instead of:** ${a.insteadOf}`,
        `- **The promise:** ${a.promise}`,
        `- **Opening line:** "${a.sampleOpeningLine}"`,
        `- **Best on:** ${a.bestOn.join(", ")}`,
        `- **Why:** ${a.whyWeSuggest}`,
        "",
      );
    });
    out.push(
      "## How you sound",
      `**Pitch:** ${strategy.messaging.elevatorPitch}`,
      "",
      "**One-liners**",
      list(strategy.messaging.oneLiners),
      "",
      "**Objections**",
      list(strategy.messaging.objections.map((o) => `"${o.objection}": ${o.answer}`)),
      "",
      `**Words to use:** ${strategy.messaging.wordsToUse.join(", ")}`,
      `**Words to avoid:** ${strategy.messaging.wordsToAvoid.join(", ")}`,
      "",
      "## Where to post",
      list(strategy.channelPlan.map((c) => `**${c.platform}**: ${c.role} (${c.cadence})`)),
      "",
    );
  }
  if (input.launchDate) out.push("## Launch", `Planned launch day: ${input.launchDate}`, "");
  return out.join("\n");
}

export async function publicClaimsFor(db: Db, dnaVersionId: string) {
  return (await db.select().from(claims).where(and(eq(claims.dnaVersionId, dnaVersionId), eq(claims.publicOk, true)))).filter(
    (c) => c.status !== "rejected",
  );
}
