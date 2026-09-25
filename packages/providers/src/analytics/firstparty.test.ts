import { describe, expect, it } from "vitest";
import { aggregateUrl, fetchFirstPartyAggregate, parseAggregateResponse } from "./firstparty.ts";

describe("first-party aggregate", () => {
  it("builds the URL and sends the bearer token", async () => {
    let auth: string | undefined;
    const rows = await fetchFirstPartyAggregate(
      {
        baseUrl: "https://syllacal.com",
        token: "tok",
        fetch: async (url, init) => {
          expect(url).toBe("https://syllacal.com/api/marketing/aggregate?from=2026-10-01&to=2026-10-07");
          auth = (init.headers as Record<string, string>).Authorization;
          return new Response(JSON.stringify({ rows: [{ day: "2026-10-01", utm_source: "tiktok", utm_content: null, visits: 3, signups: 1, purchases: 0 }] }));
        },
      },
      "2026-10-01",
      "2026-10-07",
    );
    expect(auth).toBe("Bearer tok");
    expect(rows).toEqual([{ day: "2026-10-01", utm_source: "tiktok", utm_content: "", utm_term: "", visits: 3, signups: 1, purchases: 0 }]);
    expect(aggregateUrl("https://a.test/x", "2026-01-01", "2026-01-02")).toBe("https://a.test/api/marketing/aggregate?from=2026-01-01&to=2026-01-02");
  });

  it("rejects bad rows, ranges and statuses", async () => {
    expect(() => parseAggregateResponse({ rows: [{ day: "2026-10-01", visits: -1, signups: 0, purchases: 0 }] })).toThrow(/visits/);
    expect(() => parseAggregateResponse({})).toThrow(/rows/);
    const opts = { baseUrl: "https://a.test", token: "t", fetch: async () => new Response("no", { status: 401 }) };
    await expect(fetchFirstPartyAggregate(opts, "2026-10-01", "2026-10-01")).rejects.toThrow(/401/);
    await expect(fetchFirstPartyAggregate(opts, "2026-01-01", "2026-12-31")).rejects.toThrow(/range/);
  });
});
