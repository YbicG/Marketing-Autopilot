import { and, desc, eq } from "drizzle-orm";
import { ANGLE_COUNT, StrategyOutput, type ProductDna } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { callClaudeJson } from "../ai/call.ts";
import { budgetScopesForRun, describeFailure, runSpentMicros } from "../runs/summary.ts";
import { assetsFor, claimsFor } from "./profile.ts";
import type { IngestDeps } from "./types.ts";

const { generationRuns, productDnaVersions, products, strategies, angles } = schema;

/** §2.5: test all 3, mostly #1. */
export const ANGLE_SHARES = [60, 20, 20] as const;
const MIN_LEAD_DAYS = 14;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** D21: the seasonal date the strategy suggests if it's at least 14 days out, else the first Tuesday that is. */
export function defaultLaunchDate(suggested: string | null, now: Date): string {
  const earliest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + MIN_LEAD_DAYS));
  if (suggested && /^\d{4}-\d{2}-\d{2}$/.test(suggested)) {
    const d = new Date(`${suggested}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d >= earliest && d.getTime() - earliest.getTime() < 400 * 86_400_000) return suggested;
  }
  const d = new Date(earliest);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

/** The compact profile the strategy call reads (the start of the campaign bundle in M2). */
export function compactDna(dna: ProductDna): string {
  const { identity: i, offer: o, market: m } = dna;
  return [
    `Name: ${i.name}`,
    `One-liner: ${i.oneLiner}`,
    `Category: ${i.category} · Platforms: ${i.platforms.join(", ")}`,
    `Who it's for: ${i.whoItsFor}`,
    ...i.audiences.map((a) => `Audience "${a.name}": ${a.description}. Pains: ${a.painPoints.join("; ")}`),
    `Trying to get done: ${i.jobs.join("; ")}`,
    `Voice: ${i.voice.tone}. Use: ${i.voice.wordsToUse.join(", ")}. Avoid: ${i.voice.wordsToAvoid.join(", ")}`,
    `Features: ${o.features.map((f) => `${f.name} (${f.description})`).join("; ")}`,
    `Pricing (${o.pricing.model}): ${o.pricing.summary}`,
    `Different because: ${o.differentiators.join("; ")}`,
    `Competitors: ${m.competitors.map((c) => `${c.name}: ${c.howTheyDiffer}`).join("; ")}`,
    `Pains people describe: ${m.pains.map((p) => p.text).join("; ")}`,
    `Seasonality: ${m.seasonality.summary} ${m.seasonality.peaks.map((p) => `${p.months} (${p.reason})`).join("; ")}`,
    `Channels: ${m.channels.map((c) => `${c.platform} (${c.why})`).join("; ")}`,
    `Search terms: ${m.searchTerms.join(", ")}`,
  ].join("\n");
}

/**
 * strategy.positioning (Opus, effort high): 3 angle cards, messaging, channel plan and a launch
 * window, from the DNA plus the claims that are safe to use in public.
 */
export async function executeStrategyRun(deps: IngestDeps, runId: string): Promise<void> {
  const { db, publish } = deps;
  const now = deps.now ?? (() => new Date());
  const [run] = await db.select().from(generationRuns).where(eq(generationRuns.id, runId));
  if (!run || run.status !== "queued" || !run.productId) return;
  await db.update(generationRuns).set({ status: "running", startedAt: now() }).where(eq(generationRuns.id, runId));
  try {
    await publish({ type: "stage_started", stage: "strategy", label: "Picking your angles" });
    const dnaVersionId = String(run.input.dnaVersionId);
    const [version] = await db.select().from(productDnaVersions).where(eq(productDnaVersions.id, dnaVersionId));
    if (!version) throw new Error("dna version missing");
    const dna = version.dna as unknown as ProductDna;
    const allClaims = await claimsFor(db, dnaVersionId);
    const publicClaims = allClaims.filter((c) => c.publicOk && c.status !== "rejected");
    const shots = (await assetsFor(db, run.productId)).filter((a) => {
      const l = a.labels as { usefulForMarketing?: boolean; hasPersonalData?: boolean } | null;
      return l && l.usefulForMarketing !== false && !l.hasPersonalData;
    });

    const periods = await budgetScopesForRun(db, run.workspaceId, runId, run.capMicros);
    const { value, servedModel } = await callClaudeJson(
      { db, rates: deps.rates, client: deps.client },
      {
        workspaceId: run.workspaceId,
        budgetPeriodIds: periods,
        runId,
        feature: "strategy.positioning",
        schema: StrategyOutput,
        system: `You are the marketing lead for a solo developer who is not a marketer. From the product profile, write:
- exactly ${ANGLE_COUNT} angles, strongest first. Each angle is one clear reason a specific group would switch from what they use today. Make them genuinely different (different audience, pain or promise), not three wordings of one idea. Where it fits, one angle should contrast the manual way with the product's one-step way.
- messaging: 3–5 one-liners, a 2–3 sentence pitch, the top objections with honest answers, words to use and to avoid.
- a channel plan (platform, its role, a realistic cadence for one person).
- a launch window: an ISO date tied to the product's busy season if there is one, else null, and why.
Only use facts from the profile. Numbers, prices and comparisons may come only from the listed public claims, and claimIds must be ids from that list. screenshotAssetIds must be asset ids from the list (up to 3 per angle, the ones that best show the promise).
Today is ${iso(now())}. Plain words, no marketing jargon (no ICP, JTBD, CTA, funnel, value prop).`,
        messages: [
          {
            role: "user",
            content: `<profile>\n${compactDna(dna)}\n</profile>\n\n<public_claims>\n${
              publicClaims.map((c) => `${c.ref} (${c.kind}): ${c.text}`).join("\n") || "none"
            }\n</public_claims>\n\n<screenshots>\n${
              shots.map((a) => `${a.id}: ${(a.labels as { caption?: string }).caption ?? ""} (${String(a.origination.viewport ?? "")})`).join("\n") || "none"
            }\n</screenshots>\n\nWrite the strategy.`,
          },
        ],
      },
    );

    const claimRefs = new Set(publicClaims.map((c) => c.ref));
    const shotIds = new Set(shots.map((a) => a.id));
    const cards = value.angles.slice(0, ANGLE_COUNT).map((a) => ({
      ...a,
      claimIds: a.claimIds.filter((id) => claimRefs.has(id)),
      screenshotAssetIds: a.screenshotAssetIds.filter((id) => shotIds.has(id)).slice(0, 3),
    }));
    if (!cards.length) throw new Error("strategy returned no angles");
    const output = { ...value, angles: cards };
    const launchDate = defaultLaunchDate(value.launchWindow.suggestedDate, now());

    const strategyId = uuidv7();
    await db.transaction(async (tx) => {
      await tx.insert(strategies).values({
        id: strategyId,
        workspaceId: run.workspaceId,
        productId: run.productId!,
        dnaVersionId,
        runId,
        output: output as unknown as Record<string, unknown>,
        servedModel,
        launchDate,
      });
      await tx.insert(angles).values(
        cards.map((card, idx) => ({
          id: uuidv7(),
          workspaceId: run.workspaceId,
          strategyId,
          idx,
          card: card as unknown as Record<string, unknown>,
          sharePct: cards.length === ANGLE_COUNT ? ANGLE_SHARES[idx]! : Math.round(100 / cards.length),
        })),
      );
    });

    const spent = await runSpentMicros(db, runId);
    await publish({ type: "cost_update", spentMicros: spent });
    await db
      .update(generationRuns)
      .set({ status: "completed", result: { strategyId, servedModel, spentMicros: spent }, finishedAt: now() })
      .where(eq(generationRuns.id, runId));
    await publish({ type: "stage_done", stage: "strategy" });
    await publish({ type: "artifact_ready", kind: "strategy", id: strategyId });
    await publish({ type: "run_completed" });
  } catch (err) {
    const { code, message, retryable } = describeFailure(err);
    await db
      .update(generationRuns)
      .set({ status: "failed", error: `${code}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2_000), finishedAt: now() })
      .where(eq(generationRuns.id, runId));
    await publish({ type: "stage_failed", stage: "strategy", code, message, retryable });
  }
}

export async function latestStrategy(db: Db, productId: string) {
  const [s] = await db.select().from(strategies).where(eq(strategies.productId, productId)).orderBy(desc(strategies.createdAt)).limit(1);
  if (!s) return null;
  const rows = await db.select().from(angles).where(eq(angles.strategyId, s.id)).orderBy(angles.idx);
  return { ...s, output: s.output as unknown as StrategyOutput, angles: rows };
}

export async function setLaunchDate(db: Db, workspaceId: string, strategyId: string, date: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return false;
  const res = await db
    .update(strategies)
    .set({ launchDate: date })
    .where(and(eq(strategies.id, strategyId), eq(strategies.workspaceId, workspaceId)))
    .returning({ id: strategies.id });
  return res.length > 0;
}

export async function productBySlug(db: Db, workspaceId: string, slug: string) {
  const [p] = await db.select().from(products).where(and(eq(products.workspaceId, workspaceId), eq(products.slug, slug)));
  return p ?? null;
}
