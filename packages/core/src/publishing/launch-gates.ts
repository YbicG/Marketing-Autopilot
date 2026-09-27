import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";

const { launchPlans, launchTasks } = schema;

// D20: pre-publish checks warn in M2–M3 and become hard gates on launch day (M4-LC). The gate rows
// are launch_tasks with mode "gate", built by the launch plan (agent B1). Contract: a gate passes
// only when its status is "done" (skipped is still open). No active plan → no launch gating.

export const LAUNCH_GATE_KEYS = ["gate.tracking_test", "gate.pricing_visible", "gate.no_signup_wall", "gate.landing_audit"] as const;
export type LaunchGateKey = (typeof LAUNCH_GATE_KEYS)[number];

/** What each open gate means, in the sentence "Launch-day checks aren't done yet: …". */
const OPEN_PHRASE: Record<LaunchGateKey, string> = {
  "gate.tracking_test": "the tracking test link hasn't been opened",
  "gate.pricing_visible": "it isn't confirmed that your prices are easy to find",
  "gate.no_signup_wall": "it isn't confirmed that people can see your landing page without signing in",
  "gate.landing_audit": "the landing page check hasn't passed",
};

export interface LaunchGate {
  key: string;
  title: string;
  status: string;
  passed: boolean;
}

export interface LaunchGateStatus {
  planId: string;
  launchDate: string;
  gates: LaunchGate[];
  open: LaunchGate[];
}

export const gatePasses = (status: string) => status === "done";

/** The product's active launch plan (latest draft or active one) and its gate rows. */
export async function launchGateStatus(db: Db, workspaceId: string, productId: string): Promise<LaunchGateStatus | null> {
  const [plan] = await db
    .select({ id: launchPlans.id, launchDate: launchPlans.launchDate })
    .from(launchPlans)
    .where(and(eq(launchPlans.workspaceId, workspaceId), eq(launchPlans.productId, productId), inArray(launchPlans.status, ["draft", "active"])))
    .orderBy(desc(launchPlans.createdAt), desc(launchPlans.id))
    .limit(1);
  if (!plan) return null;
  const rows = await db
    .select({ key: launchTasks.key, title: launchTasks.title, status: launchTasks.status })
    .from(launchTasks)
    .where(and(eq(launchTasks.workspaceId, workspaceId), eq(launchTasks.launchPlanId, plan.id), eq(launchTasks.mode, "gate")))
    .orderBy(launchTasks.key);
  const gates = rows.map((r) => ({ ...r, passed: gatePasses(r.status) }));
  return { planId: plan.id, launchDate: plan.launchDate, gates, open: gates.filter((g) => !g.passed) };
}

function openPhrase(g: LaunchGate): string {
  return (OPEN_PHRASE as Record<string, string>)[g.key] ?? `"${g.title}" isn't done`;
}

function joinPlain(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function launchGateMessage(open: readonly LaunchGate[]): string {
  return `Launch-day checks aren't done yet: ${joinPlain(open.map(openPhrase))}. Finish them on the Launch page.`;
}

export function launchWarningsMessage(warnings: readonly string[]): string {
  return `On launch day every check has to pass before a post goes out. ${[...new Set(warnings)].join(" ")}`;
}

export interface LaunchDayVerdict {
  launchDay: boolean;
  /** Plain reason the post is held, or null to let it through. */
  block: string | null;
}

/**
 * Pure decision (D20). Only on the plan's launch day (the post's local date in the workspace time
 * zone): every open gate blocks, and every pre-publish warning becomes a block. Any other day, and
 * with no plan, nothing changes.
 */
export function launchDayVerdict(input: { localDate: string; launch: Pick<LaunchGateStatus, "launchDate" | "open"> | null; warnings: readonly string[] }): LaunchDayVerdict {
  if (!input.launch || input.launch.launchDate !== input.localDate) return { launchDay: false, block: null };
  if (input.launch.open.length) return { launchDay: true, block: launchGateMessage(input.launch.open) };
  if (input.warnings.length) return { launchDay: true, block: launchWarningsMessage(input.warnings) };
  return { launchDay: true, block: null };
}
