import { describe, expect, it } from "vitest";
import { hasBearer } from "./agent-guard";
import { requireUiSession } from "./ui-session";

const req = (headers: Record<string, string>) => new Request("https://mkt.example.com/api/approvals/posts", { method: "POST", headers });

describe("agent tokens outside /api/mcp", () => {
  it("approve, verify and accept routes (requireUiSession) answer 403 to a bearer token, cookie or not", async () => {
    for (const h of [
      { authorization: "Bearer mkt_pat_1a2b3c4d_00000000000000000000000000000000" },
      { authorization: "bearer x", cookie: "better-auth.session_token=abc", origin: "https://mkt.example.com", "x-mkt-csrf": "1" },
    ] as Record<string, string>[]) {
      const r = await requireUiSession(req(h));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.res.status).toBe(403);
    }
  });

  it("only the Authorization header counts", () => {
    expect(hasBearer(req({ authorization: "Bearer abc" }))).toBe(true);
    expect(hasBearer(req({ cookie: "Bearer abc" }))).toBe(false);
    expect(hasBearer(req({ authorization: "Basic abc" }))).toBe(false);
  });
});
