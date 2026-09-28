import { handleMcpRequest } from "@mkt/core/tools";
import { toolDeps } from "@/lib/agent-tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MCP over Streamable HTTP (§9), stateless: `claude mcp add --transport http mkt <host>/api/mcp
 * --header "Authorization: Bearer mkt_pat_…"`. Only the bearer token authenticates; the session
 * cookie is never read, and no tool here can approve, publish, verify or accept (D9).
 */
async function handle(req: Request): Promise<Response> {
  return handleMcpRequest(req, toolDeps());
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
