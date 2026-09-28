import type { z } from "zod";
import type { Db } from "@mkt/db";
import type { PatContext, PatScope } from "./pat.ts";

/**
 * The agent tool registry (§9). One definition per tool; MCP (and the CLI later) only list and call
 * these. What a tool may do is fixed by its effect:
 * - read: looks things up, changes nothing
 * - draft: writes drafts or pending change requests a person reviews
 * - publish_request: queues items as waiting for approval, never approves them
 * - spend: costs money; two phases (estimate, then run within the token's limits or with a UI confirm)
 *
 * There are no approve, publish, verify, accept or activate tools (D9, D10), and defineTool refuses
 * a name that suggests one.
 */
export const TOOL_EFFECTS = ["read", "draft", "spend", "publish_request"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

export const FORBIDDEN_TOOL_VERBS = /(^|_)(approve|publish|verify|accept|activate|confirm)(_|$)/;

export interface ToolDeps {
  db: Db;
  /** APP_BASE_URL, for deep links back into the app. */
  baseUrl: string;
  /** CONFIRM_TOKEN_SECRET, read lazily so a missing secret only breaks spend tools. */
  confirmSecret: () => string;
  /** package.orchestrate for a new package run (the same job the web button enqueues). */
  enqueueOrchestrate: (runId: string) => Promise<void>;
  now?: () => Date;
}

export interface ToolRunCtx {
  db: Db;
  pat: PatContext;
  deps: ToolDeps;
  now: Date;
  /** Spend tools only: true when a person confirmed this call in the UI (the token's own limits don't apply). */
  confirmed: boolean;
}

/** A plain-English refusal a tool returns to the agent (not found, no campaign yet…). */
export class ToolError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict" | "over_limit",
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolDef<I extends z.ZodObject = z.ZodObject, O = unknown> {
  name: string;
  description: string;
  input: I;
  /** The result's shape; documentation and typing (results are built by our own code, not parsed). */
  output: z.ZodType<O>;
  effect: ToolEffect;
  scopes: readonly PatScope[];
  // Method syntax on purpose: it lets every ToolDef<I, O> sit in one AnyTool list.
  /** Spend tools: the high estimate in micro-dollars, computed before anything runs. */
  estimate?(ctx: Omit<ToolRunCtx, "confirmed">, input: z.infer<I>): Promise<number>;
  run(ctx: ToolRunCtx, input: z.infer<I>): Promise<O>;
}

/** The scope each effect needs at least (a tool may ask for more). */
export const EFFECT_SCOPE: Record<ToolEffect, PatScope> = { read: "read", draft: "draft", publish_request: "draft", spend: "generate" };

export function defineTool<I extends z.ZodObject, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (!/^[a-z][a-z_]{2,40}$/.test(def.name)) throw new Error(`Bad tool name ${def.name}`);
  if (FORBIDDEN_TOOL_VERBS.test(def.name)) throw new Error(`${def.name}: agents can't approve, publish, verify or accept (D9)`);
  if (!def.scopes.includes(EFFECT_SCOPE[def.effect])) throw new Error(`${def.name}: a ${def.effect} tool needs the ${EFFECT_SCOPE[def.effect]} scope`);
  if (def.effect === "spend" && !def.estimate) throw new Error(`${def.name}: a spend tool needs an estimate`);
  return def;
}

export type AnyTool = ToolDef<z.ZodObject, unknown>;

export function toolRegistry(tools: readonly AnyTool[]): ReadonlyMap<string, AnyTool> {
  const map = new Map<string, AnyTool>();
  for (const t of tools) {
    if (map.has(t.name)) throw new Error(`Duplicate tool ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}
