/**
 * D9, §9: an agent token (Authorization: Bearer mkt_pat_…) is only for /api/mcp. Everywhere else a
 * request that carries one is treated as not signed in, and the approve, verify and accept routes
 * (requireUiSession) refuse it outright with 403, even if a browser cookie came along too.
 */
export function hasBearer(req: Request): boolean {
  return /^bearer\s/i.test(req.headers.get("authorization") ?? "");
}

export function bearerRefused(): Response {
  return Response.json({ error: "Agent tokens can't do this. Open the app and do it yourself." }, { status: 403 });
}
