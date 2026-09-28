import { and, eq, sql } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { PAT_CALL_MAX_MICROS, patPeriod } from "../cost/pat-limits.ts";
import { formatUsd } from "../cost/pricing.ts";
import { BudgetExceeded } from "../cost/errors.ts";
import { canonicalJson, sha256Hex } from "../engine/hash.ts";
import { confirmUrl, verifyToolConfirmToken } from "./confirm.ts";
import type { PatContext } from "./pat.ts";
import { ToolError, type AnyTool, type ToolDeps, type ToolRunCtx } from "./registry.ts";

const { auditLog } = schema;

export type ToolErrorCode = "unknown_tool" | "invalid_input" | "forbidden" | "not_found" | "conflict" | "over_limit" | "confirm_invalid" | "failed";

export type ToolOutcome =
  | { status: "ok"; result: unknown }
  | {
      status: "pending_confirmation";
      estimateMicros: number;
      confirmToken?: undefined;
      /** Open this in the browser (signed in), check and confirm, then pass the code it shows back as confirmToken. */
      confirmUrl: string;
      message: string;
    }
  | { status: "error"; code: ToolErrorCode; message: string };

export interface InvokeCtx {
  pat: PatContext;
  deps: ToolDeps;
  tools: ReadonlyMap<string, AnyTool>;
}

/**
 * One agent tool call (§9): find the tool, validate the input with its zod schema, check the
 * token's scopes, and for spend tools run the two phases (D10). Every call writes an audit_log row
 * with actor "pat", whatever the outcome. Tools never receive a UiSession, so nothing reached from
 * here can approve.
 */
export async function invokeTool(ctx: InvokeCtx, name: string, rawInput: unknown, confirmToken?: string): Promise<ToolOutcome> {
  const { deps, pat } = ctx;
  const db = deps.db;
  const now = deps.now?.() ?? new Date();
  const tool = ctx.tools.get(name);
  const audit = (outcome: ToolOutcome, extra: Record<string, unknown> = {}) =>
    writeAudit(db, pat, name, tool?.effect ?? null, outcome, { inputHash: sha256Hex(canonicalJson(rawInput ?? null)), ...extra });

  if (!tool) return audit(fail("unknown_tool", `There's no tool called ${name}.`));
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return audit(fail("invalid_input", msg));
  }
  const input = parsed.data;
  const missing = tool.scopes.filter((s) => !pat.scopes.includes(s));
  if (missing.length) return audit(fail("forbidden", `This token can't ${missing.join(" or ")}. Make one with that permission in Settings → Agent access.`));

  const base = { db, pat, deps, now };
  try {
    let confirmed = false;
    let nonce: string | undefined;
    let estimateMicros: number | undefined;
    if (tool.effect === "spend") {
      estimateMicros = await tool.estimate!(base, input);
      const phase = await spendPhase(base, tool.name, input, estimateMicros, confirmToken);
      if (phase.outcome) return audit(phase.outcome, { estimateMicros });
      confirmed = phase.confirmed;
      nonce = phase.nonce;
    }
    const runCtx: ToolRunCtx = { ...base, confirmed };
    const result = await tool.run(runCtx, input);
    const outcome: ToolOutcome = { status: "ok", result };
    await audit(outcome, { ...(estimateMicros !== undefined ? { estimateMicros, confirmed } : {}), ...(nonce ? { confirmNonce: nonce } : {}), ...jobOf(result) });
    return outcome;
  } catch (err) {
    if (err instanceof ToolError) return audit(fail(err.code === "invalid" ? "invalid_input" : err.code, err.message));
    if (err instanceof BudgetExceeded) return audit(fail("over_limit", "That would go over a spending limit. Raise it in Settings or try something cheaper."));
    console.error("[tools] failed", name, err);
    return audit(fail("failed", "Something went wrong on the server. Try again."));
  }
}

const fail = (code: ToolErrorCode, message: string): ToolOutcome => ({ status: "error", code, message });

const jobOf = (result: unknown) =>
  result && typeof result === "object" && typeof (result as { jobId?: unknown }).jobId === "string" ? { jobId: (result as { jobId: string }).jobId } : {};

/**
 * Spend phase 1/2 (D10). With a confirm token: it must be valid for this tool, token, input and a
 * price at least today's, and unused. Without one: the call runs only if the estimate is ≤ $0.50
 * and fits what's left of the token's $10 this month (its budget_periods row, the same one the
 * run's paid calls reserve against); otherwise it returns pending_confirmation and a link.
 */
async function spendPhase(
  ctx: Omit<ToolRunCtx, "confirmed">,
  tool: string,
  input: unknown,
  estimateMicros: number,
  confirmToken: string | undefined,
): Promise<{ outcome?: ToolOutcome; confirmed: boolean; nonce?: string }> {
  const { db, pat, deps, now } = ctx;
  if (confirmToken) {
    const v = verifyToolConfirmToken(confirmToken, { workspaceId: pat.workspaceId, patId: pat.patId, tool, input, estimateMicros }, deps.confirmSecret(), now.getTime());
    if (!v.ok) {
      const why =
        v.reason === "expired"
          ? "That confirmation has expired (they last 10 minutes)."
          : v.reason === "price_changed"
            ? "The price went up since it was confirmed."
            : "That confirmation doesn't match this request.";
      return { outcome: fail("confirm_invalid", `${why} Open the link again to confirm.`), confirmed: false };
    }
    if (await nonceUsed(db, pat.workspaceId, v.payload.nonce)) {
      return { outcome: fail("confirm_invalid", "That confirmation was already used. Open the link again to confirm."), confirmed: false };
    }
    return { confirmed: true, nonce: v.payload.nonce };
  }

  const link = confirmUrl(deps.baseUrl, tool, pat.patId, input);
  if (estimateMicros > PAT_CALL_MAX_MICROS) {
    return {
      outcome: {
        status: "pending_confirmation",
        estimateMicros,
        confirmUrl: link,
        message: `This could cost up to ${formatUsd(estimateMicros)}, more than the ${formatUsd(PAT_CALL_MAX_MICROS)} an agent may spend in one go. Ask the owner to confirm it.`,
      },
      confirmed: false,
    };
  }
  const p = await patPeriod(db, pat.workspaceId, pat.patId);
  if (p.spentMicros + p.reservedMicros + estimateMicros > p.capMicros) {
    return {
      outcome: {
        status: "pending_confirmation",
        estimateMicros,
        confirmUrl: link,
        message: `This token has ${formatUsd(Math.max(0, p.capMicros - p.spentMicros - p.reservedMicros))} of its ${formatUsd(p.capMicros)} left this month. Ask the owner to confirm it.`,
      },
      confirmed: false,
    };
  }
  return { confirmed: false };
}

/** Confirm tokens are single use: the nonce of every confirmed call is in its audit row. */
async function nonceUsed(db: Db, workspaceId: string, nonce: string): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.actorType, "pat"), sql`${auditLog.data}->>'confirmNonce' = ${nonce}`))
    .limit(1);
  return !!row;
}

async function writeAudit(db: Db, pat: PatContext, name: string, effect: string | null, outcome: ToolOutcome, extra: Record<string, unknown>): Promise<ToolOutcome> {
  await db.insert(auditLog).values({
    id: uuidv7(),
    workspaceId: pat.workspaceId,
    actorType: "pat",
    actorId: pat.patId,
    action: `tool.${name}`,
    entity: `pat:${pat.patId}`,
    data: { effect, status: outcome.status, ...(outcome.status === "error" ? { code: outcome.code } : {}), ...extra },
  });
  return outcome;
}
