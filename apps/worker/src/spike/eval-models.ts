/**
 * Model eval: replay captured calls on cheaper models and have Opus judge them blind against the
 * answer the current model gave. Capture first by running the app with AI_CAPTURE_PROMPTS=1 for a
 * while, then in the worker container:
 *   pnpm --filter @mkt/worker eval:models
 * Env (all optional):
 *   EVAL_CANDIDATES   comma list of provider:model[@effort] (default: GLM-5.3 Flash, DeepSeek V4.1 Flash, GPT-6 Luna)
 *   EVAL_PER_FEATURE  newest samples per feature (default 8)
 *   EVAL_FEATURES     comma list of feature ids (default: every feature with captures)
 *   EVAL_CAP_USD      hard spending cap for this run (default 5)
 *   EVAL_WORKSPACE_ID the workspace the spend is charged to (default: the first one)
 * Prints a table and a suggested AI_MODEL_OVERRIDES line. Nothing is changed.
 */
import { createDb, schema, uuidv7 } from "@mkt/db";
import {
  FEATURES,
  evalOne,
  loadEvalSamples,
  overridesLine,
  recommend,
  summarize,
  type EvalRow,
  type FeatureId,
  type ModelOverride,
} from "@mkt/core/ai";
import { env } from "@mkt/core/config";
import { formatUsd, loadRateCards, rateLookup, seedPricingRates } from "@mkt/core/cost";
import { budgetScopesForRun } from "@mkt/core/runs";

const DEFAULT_CANDIDATES = "openrouter:z-ai/glm-5.3-flash,openrouter:deepseek/deepseek-v4.1-flash,openrouter:openai/gpt-6-luna";

function parseCandidates(raw: string): ModelOverride[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(anthropic|openrouter):([^@\s]+)(?:@(low|medium|high|xhigh|max))?$/.exec(s);
      if (!m) throw new Error(`EVAL_CANDIDATES: "${s}" isn't provider:model[@effort]`);
      return { provider: m[1] as ModelOverride["provider"], model: m[2]!, ...(m[3] ? { effort: m[3] as ModelOverride["effort"] } : {}) };
    });
}

const config = env();
const { db, sql } = createDb(config.DATABASE_URL);
await seedPricingRates(db);
const rates = rateLookup(await loadRateCards(db));

const candidates = parseCandidates(process.env.EVAL_CANDIDATES ?? DEFAULT_CANDIDATES);
const perFeature = Number(process.env.EVAL_PER_FEATURE ?? 8);
const features = process.env.EVAL_FEATURES?.split(",").map((s) => s.trim()).filter(Boolean) as FeatureId[] | undefined;
for (const f of features ?? []) if (!(f in FEATURES)) throw new Error(`EVAL_FEATURES: unknown feature ${f}`);
const capMicros = Math.round(Number(process.env.EVAL_CAP_USD ?? 5) * 1_000_000);

const workspaceId =
  process.env.EVAL_WORKSPACE_ID ??
  (await db.select({ id: schema.workspaces.id, createdAt: schema.workspaces.createdAt }).from(schema.workspaces)).sort((a, b) => +a.createdAt - +b.createdAt)[0]?.id;
if (!workspaceId) throw new Error("no workspace to charge the eval to");
const budgetPeriodIds = await budgetScopesForRun(db, workspaceId, `eval:${uuidv7()}`, capMicros);

const samples = await loadEvalSamples(db, { perFeature, ...(features ? { features } : {}) });
if (!samples.length) {
  console.log("No captured calls. Set AI_CAPTURE_PROMPTS=1 on the worker, use the app for a while, then run this again.");
  await sql.end();
  process.exit(0);
}
console.log(`${samples.length} samples × ${candidates.length} candidates, cap ${formatUsd(capMicros)}`);

const rows: EvalRow[] = [];
let stopped = false;
for (const [i, sample] of samples.entries()) {
  for (const c of candidates) {
    if (stopped) break;
    try {
      const row = await evalOne({ db, rates, workspaceId, budgetPeriodIds }, sample, c, i % 2 === 0);
      rows.push(row);
      console.log(`${row.outcome.padEnd(5)} ${sample.feature} ${row.candidate} ${formatUsd(row.candidateMicros)}${row.note && row.outcome === "error" ? ` (${row.note})` : ""}`);
    } catch (err) {
      // The judge call failed; budget_exceeded ends the run, anything else skips the pair.
      if ((err as { code?: string }).code === "budget_exceeded") {
        console.log("Eval cap reached; reporting what ran.");
        stopped = true;
      } else console.warn(`skip  ${sample.feature} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

const summaries = summarize(rows).sort((a, b) => a.feature.localeCompare(b.feature) || a.avgMicros - b.avgMicros);
console.log("\nfeature                     candidate                                   n  win tie loss err  score   avg cost  current");
for (const s of summaries) {
  console.log(
    `${s.feature.padEnd(27)} ${s.candidate.padEnd(43)} ${String(s.n).padStart(2)} ${String(s.wins).padStart(4)} ${String(s.ties).padStart(3)} ${String(s.losses).padStart(4)} ${String(s.errors).padStart(3)}  ${s.score.toFixed(2)}  ${formatUsd(s.avgMicros).padStart(9)}  ${s.baselineAvgMicros === null ? "?" : formatUsd(s.baselineAvgMicros)}`,
  );
}
const picks = recommend(summaries);
console.log(picks.size ? `\nSuggested (review before using):\nAI_MODEL_OVERRIDES=${overridesLine(picks)}` : "\nNo candidate held up on enough samples; keep the defaults.");
await sql.end();
