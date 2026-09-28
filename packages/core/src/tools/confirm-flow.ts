import { schema, uuidv7, type Db } from "@mkt/db";
import type { UiSession } from "../publishing/approvals.ts";
import { decodeConfirmInput, mintToolConfirmToken } from "./confirm.ts";
import { TOOL_MAP } from "./mcp.ts";
import { activePat } from "./pat.ts";
import type { AnyTool, ToolDeps } from "./registry.ts";

/**
 * The confirm page behind a pending_confirmation link (D10, §9 spend phase 2). The link says which
 * tool, token and input; the price is always worked out again here, never taken from the link.
 */

export type ConfirmRequest =
  | { ok: true; tool: AnyTool; patName: string; patId: string; input: unknown; estimateMicros: number }
  | { ok: false; message: string };

export async function loadToolConfirm(
  db: Db,
  workspaceId: string,
  q: { tool: string | null | undefined; pat: string | null | undefined; input: string | null | undefined },
  deps: ToolDeps,
  tools: ReadonlyMap<string, AnyTool> = TOOL_MAP,
): Promise<ConfirmRequest> {
  const tool = q.tool ? tools.get(q.tool) : undefined;
  if (!tool || tool.effect !== "spend" || !tool.estimate) return { ok: false, message: "This link doesn't point to anything that needs confirming." };
  if (!q.pat || !/^[0-9a-f-]{36}$/i.test(q.pat)) return { ok: false, message: "This link is missing the token it's for." };
  const now = deps.now?.() ?? new Date();
  const pat = await activePat(db, workspaceId, q.pat, now);
  if (!pat) return { ok: false, message: "The token that asked for this was revoked, has expired, or belongs to another workspace." };
  if (!pat.scopes.includes("generate")) return { ok: false, message: "That token isn't allowed to spend." };
  const parsed = tool.input.safeParse(decodeConfirmInput(q.input));
  if (!parsed.success) return { ok: false, message: "This link is damaged. Ask the agent to try again." };
  try {
    const ctx = { db, pat: { patId: pat.id, workspaceId, scopes: pat.scopes, createdBy: "" }, deps, now };
    const estimateMicros = await tool.estimate(ctx, parsed.data);
    return { ok: true, tool, patName: pat.name, patId: pat.id, input: parsed.data, estimateMicros };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Couldn't work out the price. Try again." };
  }
}

/** Confirm → the code the agent passes back as confirmToken. Only a UiSession can mint it. */
export async function confirmToolCall(
  db: Db,
  session: UiSession,
  q: { tool: string; pat: string; input: string },
  deps: ToolDeps,
): Promise<{ ok: true; confirmToken: string; estimateMicros: number; expiresInMin: number } | { ok: false; message: string }> {
  const r = await loadToolConfirm(db, session.workspaceId, q, deps);
  if (!r.ok) return r;
  const now = deps.now?.() ?? new Date();
  const confirmToken = mintToolConfirmToken(session, { tool: r.tool.name, patId: r.patId, input: r.input, estimateMicros: r.estimateMicros }, deps.confirmSecret(), now.getTime());
  await db.insert(schema.auditLog).values({
    id: uuidv7(),
    workspaceId: session.workspaceId,
    actorType: "user",
    actorId: session.userId,
    action: "tool.confirm",
    entity: `pat:${r.patId}`,
    data: { tool: r.tool.name, estimateMicros: r.estimateMicros },
  });
  return { ok: true, confirmToken, estimateMicros: r.estimateMicros, expiresInMin: 10 };
}
