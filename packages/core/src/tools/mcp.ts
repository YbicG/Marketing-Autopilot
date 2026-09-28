import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DRAFT_TOOLS } from "./draft-tools.ts";
import { invokeTool, type ToolOutcome } from "./invoke.ts";
import { verifyPat, type PatContext } from "./pat.ts";
import { READ_TOOLS } from "./read-tools.ts";
import { toolRegistry, type AnyTool, type ToolDeps } from "./registry.ts";
import { SPEND_TOOLS } from "./spend-tools.ts";

/**
 * The MCP endpoint (§9): Streamable HTTP, stateless (a fresh server per request, JSON responses),
 * authenticated by a personal access token in `Authorization: Bearer` and nothing else. Cookies are
 * never read here, so a browser session can't be borrowed by an agent, and a token never becomes a
 * UiSession (D9).
 *
 * The low-level Server (not McpServer) on purpose: every call, including one with bad input, goes
 * through invokeTool, which validates it with the registry's own schema and writes the audit row.
 */

export const TOOLS: readonly AnyTool[] = [...READ_TOOLS, ...DRAFT_TOOLS, ...SPEND_TOOLS];
export const TOOL_MAP = toolRegistry(TOOLS);

const CONFIRM_FIELD = "confirmToken";

/** tools/list: each tool's JSON schema; spend tools take the confirm code as one more field. */
export function toolListing(tools: readonly AnyTool[] = TOOLS) {
  return tools.map((t) => {
    const input = t.effect === "spend" ? t.input.extend({ [CONFIRM_FIELD]: z.string().max(2_000).optional().describe("The code from the owner's confirm page, if this call needed one") }) : t.input;
    const { $schema: _drop, ...inputSchema } = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      inputSchema: { ...inputSchema, type: "object" as const } as { type: "object"; properties?: Record<string, unknown>; [k: string]: unknown },
      annotations: { readOnlyHint: t.effect === "read", destructiveHint: false, openWorldHint: t.effect === "spend" },
    };
  });
}

export function createMcpServer(pat: PatContext, deps: ToolDeps, tools: ReadonlyMap<string, AnyTool> = TOOL_MAP): Server {
  const server = new Server({ name: "marketing-autopilot", version: "0.1.0" }, { capabilities: { tools: {} } });
  const list = toolListing([...tools.values()]);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: list }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { [CONFIRM_FIELD]: confirm, ...args } = (req.params.arguments ?? {}) as Record<string, unknown>;
    const outcome = await invokeTool({ pat, deps, tools }, req.params.name, args, typeof confirm === "string" && confirm ? confirm : undefined);
    return toResult(outcome);
  });
  return server;
}

/** Results as JSON text; errors and pending confirmations are marked so an agent stops and reads them. */
export function toResult(outcome: ToolOutcome): CallToolResult {
  const body = outcome.status === "ok" ? outcome.result : outcome;
  return { content: [{ type: "text", text: JSON.stringify(body ?? null, null, 2) }], isError: outcome.status === "error" };
}

const unauthorized = (message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="mkt"' },
  });

/** The bearer token of a request, or null. Only the Authorization header counts. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m ? m[1]! : null;
}

/** One HTTP request to /api/mcp: authenticate the token, then hand the request to a fresh stateless transport. */
export async function handleMcpRequest(req: Request, deps: ToolDeps): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return unauthorized("Send a personal access token: Authorization: Bearer mkt_pat_…");
  const pat = await verifyPat(deps.db, token, deps.now?.() ?? new Date());
  if (!pat) return unauthorized("That token isn't valid. It may have been revoked or expired; make a new one in Settings → Agent access.");

  const server = createMcpServer(pat, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // JSON responses are complete once handleRequest resolves; nothing is kept between requests.
    void server.close();
  }
}
