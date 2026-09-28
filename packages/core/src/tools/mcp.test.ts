// End to end through the real MCP SDK client and our Streamable HTTP handler, in process: a
// token's agent can read and draft, spend over its limits waits for a person, and nothing it can
// reach approves, publishes, verifies or accepts (D9, D10, §9).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { ProductDna, StrategyOutput } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { PAT_CALL_MAX_MICROS, patPeriod } from "../cost/pat-limits.ts";
import { uiSessionFromCookie, type UiSession } from "../publishing/approvals.ts";
import { seedWorkspace, type Seeded } from "../publishing/test-fixtures.ts";
import { mintToolConfirmToken } from "./confirm.ts";
import { confirmToolCall, loadToolConfirm } from "./confirm-flow.ts";
import { acceptDnaChange } from "./dna-changes.ts";
import { invokeTool } from "./invoke.ts";
import { handleMcpRequest } from "./mcp.ts";
import { mintPat, verifyPat, type PatContext } from "./pat.ts";
import { defineTool, toolRegistry, type ToolDeps } from "./registry.ts";

const SECRET = "test-confirm-secret-at-least-32-characters";
const NOW = new Date("2026-10-01T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let s: Seeded;
let slug: string;
let ui: UiSession;
let token: string;
let readOnly: string;
let deps: ToolDeps;
const enqueued: string[] = [];

const DNA: ProductDna = {
  identity: {
    name: "SyllaCal",
    oneLiner: "Syllabus to calendar in 15 seconds",
    category: "Student productivity",
    platforms: ["web"],
    whoItsFor: "College students",
    audiences: [{ name: "Students", description: "Undergrads", painPoints: ["Missed deadlines"] }],
    jobs: ["Get every deadline into my calendar"],
    voice: { tone: "friendly", wordsToUse: ["semester"], wordsToAvoid: ["synergy"] },
  },
  offer: {
    features: [{ name: "Upload", description: "PDF in, events out" }],
    pricing: { model: "one_time", summary: "From $4.99", tiers: [] },
    proof: [],
    differentiators: ["One-time price"],
  },
  market: {
    competitors: [],
    pains: [],
    seasonality: { peaks: [], summary: "Back to school" },
    channels: [],
    searchTerms: [],
  },
};

const STRATEGY: StrategyOutput = {
  angles: [
    {
      title: "Syllabus week, done in 15 seconds",
      forWho: "College students",
      insteadOf: "Typing dates by hand",
      promise: "Every deadline in your calendar",
      sampleOpeningLine: "POV: you just got 5 syllabi",
      bestOn: ["threads"],
      whyWeSuggest: "It's the first thing students do each term",
      claimIds: ["C1"],
      screenshotAssetIds: [],
    },
  ],
  messaging: { oneLiners: ["Drop your syllabus, get your semester"], elevatorPitch: "SyllaCal puts every deadline in your calendar.", objections: [], wordsToUse: [], wordsToAvoid: [] },
  channelPlan: [{ platform: "threads", role: "main", cadence: "3/week" }],
  launchWindow: { suggestedDate: null, reason: "none" },
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  s = await seedWorkspace(db);
  await db.update(schema.workspaces).set({ onboardedAt: NOW }).where(eq(schema.workspaces.id, s.workspaceId));
  await db.update(schema.products).set({ kind: "web_b2c" }).where(eq(schema.products.id, s.productId));
  // A whole profile and plan, so a confirmed run_package can freeze its bundle.
  await db.update(schema.productDnaVersions).set({ dna: DNA as unknown as Record<string, unknown> }).where(eq(schema.productDnaVersions.id, s.dnaVersionId));
  await db.update(schema.strategies).set({ output: STRATEGY as unknown as Record<string, unknown> }).where(eq(schema.strategies.productId, s.productId));
  await db.update(schema.angles).set({ card: STRATEGY.angles[0] as unknown as Record<string, unknown> }).where(eq(schema.angles.id, s.angleId));
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, s.productId));
  slug = p!.slug;
  ui = uiSessionFromCookie({ userId: "user-1", workspaceId: s.workspaceId, originChecked: true, csrfChecked: true });
  token = (await mintPat(db, ui, { name: "agent", scopes: ["read", "draft", "generate"] }, NOW)).token;
  readOnly = (await mintPat(db, ui, { name: "reader", scopes: ["read"] }, NOW)).token;
  deps = {
    db,
    baseUrl: "https://mkt.example.com",
    confirmSecret: () => SECRET,
    enqueueOrchestrate: async (runId) => {
      enqueued.push(runId);
    },
    now: () => NOW,
  };
});
afterAll(() => close());

async function connect(bearer: string | null) {
  const transport = new StreamableHTTPClientTransport(new URL("https://mkt.example.com/api/mcp"), {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
    fetch: (url, init) => handleMcpRequest(new Request(url, init), deps),
  });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return { isError: !!r.isError, body: JSON.parse(text) as Record<string, unknown> };
}

describe("MCP endpoint", () => {
  it("wants a bearer token: no header, a cookie or a bad token get 401", async () => {
    const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" };
    expect((await handleMcpRequest(new Request("https://mkt.example.com/api/mcp", init), deps)).status).toBe(401);
    const withCookie = new Request("https://mkt.example.com/api/mcp", { ...init, headers: { ...init.headers, cookie: "better-auth.session_token=abc" } });
    expect((await handleMcpRequest(withCookie, deps)).status).toBe(401);
    await expect(connect("mkt_pat_00000000_00000000000000000000000000000000")).rejects.toThrow();
  });

  it("lists the tools, with no way to approve, publish, verify or accept", async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_products", "create_post_variants", "schedule_posts", "run_package"]));
    expect(names.filter((n) => /approve|publish|verify|accept/.test(n))).toEqual([]);
    await client.close();
  });

  it("create_post_variants makes drafts and no posts", async () => {
    const client = await connect(token);
    const before = await db.select().from(schema.posts).where(eq(schema.posts.workspaceId, s.workspaceId));
    const r = await call(client, "create_post_variants", {
      product: slug,
      posts: [
        { platform: "threads", text: "Paste your syllabus, get every due date on your calendar. {{link:landing}}", claimRefs: ["C1"] },
        { platform: "bluesky", text: "Every due date from your syllabus, on your calendar.", claimRefs: ["C1"] },
      ],
    });
    expect(r.isError).toBe(false);
    const out = r.body as { contentItemId: string; variants: { variantId: string; platform: string; problems: string[] }[] };
    expect(out.variants.map((v) => v.platform)).toEqual(["threads", "bluesky"]);
    expect(out.variants.every((v) => v.problems.length === 0)).toBe(true);

    const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, out.contentItemId));
    expect(item).toMatchObject({ slotKind: "agent", campaignId: s.campaignId, status: "ready" });
    const vs = await db.select().from(schema.variants).where(eq(schema.variants.contentItemId, out.contentItemId));
    expect(vs).toHaveLength(2);
    const after = await db.select().from(schema.posts).where(eq(schema.posts.workspaceId, s.workspaceId));
    expect(after).toHaveLength(before.length);

    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.workspaceId, s.workspaceId), eq(schema.auditLog.action, "tool.create_post_variants")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "pat", data: expect.objectContaining({ effect: "draft", status: "ok" }) });

    // schedule_posts puts one on the calendar as waiting for approval, never approved.
    const at = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
    const sch = await call(client, "schedule_posts", { product: slug, posts: [{ variantId: out.variants[0]!.variantId, at }] });
    expect(sch.isError).toBe(false);
    const scheduled = (sch.body as { scheduled: { postId: string; state: string }[] }).scheduled;
    expect(scheduled).toHaveLength(1);
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, scheduled[0]!.postId));
    expect(post).toMatchObject({ state: "pending_approval", approvalId: null, connectionId: s.connectionId });
    const again = await call(client, "schedule_posts", { product: slug, posts: [{ variantId: out.variants[0]!.variantId, at }] });
    expect(again.isError).toBe(true);
    await client.close();
  });

  it("run_package over $0.50 comes back pending_confirmation and starts nothing", async () => {
    const client = await connect(token);
    const runsBefore = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.workspaceId, s.workspaceId));
    const r = await call(client, "run_package", { product: slug, tier: "quick" });
    expect(r.isError).toBe(false);
    expect(r.body.status).toBe("pending_confirmation");
    expect(r.body.confirmToken).toBeUndefined();
    expect(r.body.estimateMicros as number).toBeGreaterThan(PAT_CALL_MAX_MICROS);
    const link = new URL(String(r.body.confirmUrl));
    expect(link.origin + link.pathname).toBe("https://mkt.example.com/confirm");
    expect(link.searchParams.get("tool")).toBe("run_package");
    const runsAfter = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.workspaceId, s.workspaceId));
    expect(runsAfter).toHaveLength(runsBefore.length);
    expect(enqueued).toEqual([]);

    // A made-up or tampered confirm code doesn't get it through either.
    const bad = await call(client, "run_package", { product: slug, tier: "quick", confirmToken: "abc.def" });
    expect(bad.body).toMatchObject({ status: "error", code: "confirm_invalid" });
    await client.close();
  });

  it("with the owner's confirm it runs once, as a confirmed run; the code can't be reused", async () => {
    const client = await connect(token);
    const pat = (await verifyPat(db, token, NOW))!;
    const pending = await call(client, "run_package", { product: slug, tier: "quick" });
    const input = { product: slug, tier: "quick" };
    // The owner opens the link signed in and presses Confirm (the page recomputes the price).
    const link = new URL(String(pending.body.confirmUrl));
    const q = { tool: link.searchParams.get("tool")!, pat: link.searchParams.get("pat")!, input: link.searchParams.get("input")! };
    expect(await loadToolConfirm(db, s.workspaceId, q, deps)).toMatchObject({ ok: true, patName: "agent", estimateMicros: pending.body.estimateMicros });
    expect(await loadToolConfirm(db, uuidv7(), q, deps)).toMatchObject({ ok: false });
    const confirmed = await confirmToolCall(db, ui, q, deps);
    if (!confirmed.ok) throw new Error(confirmed.message);
    const code = confirmed.confirmToken;
    // A code for other input doesn't carry over.
    const other = mintToolConfirmToken(ui, { tool: "run_package", patId: pat.patId, input: { product: slug, tier: "premium" }, estimateMicros: 99_000_000 }, SECRET, NOW.getTime());
    expect((await call(client, "run_package", { ...input, confirmToken: other })).body).toMatchObject({ code: "confirm_invalid" });
    const r = await call(client, "run_package", { ...input, confirmToken: code });
    expect(r.isError).toBe(false);
    const jobId = String(r.body.jobId);
    expect(enqueued).toEqual([jobId]);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, jobId));
    expect(run!.input.agent).toEqual({ patId: pat.patId, confirmed: true });
    const job = await call(client, "get_job", { jobId });
    expect(job.body).toMatchObject({ jobId, status: "queued" });

    const reuse = await call(client, "run_package", { ...input, confirmToken: code });
    expect(reuse.body).toMatchObject({ status: "error", code: "confirm_invalid" });
    await client.close();
  });

  it("a read-only token can't draft or spend", async () => {
    const client = await connect(readOnly);
    const r = await call(client, "create_post_variants", { product: slug, posts: [{ platform: "threads", text: "Hi" }] });
    expect(r.body).toMatchObject({ status: "error", code: "forbidden" });
    expect((await call(client, "run_package", { product: slug })).body).toMatchObject({ status: "error", code: "forbidden" });
    await client.close();
  });

  it("approve, publish, verify and accept are impossible: no such tools, and a DNA change stays pending", async () => {
    const client = await connect(token);
    for (const name of ["approve_posts", "publish_post", "verify_claim", "accept_dna_change"]) {
      expect((await call(client, name, {})).body).toMatchObject({ status: "error", code: "unknown_tool" });
    }
    const r = await call(client, "propose_dna_change", { product: slug, path: "identity.oneLiner", value: "Your syllabus, on your calendar", reason: "Shorter" });
    expect(r.body).toMatchObject({ status: "pending" });
    const [req] = await db.select().from(schema.dnaChangeRequests).where(eq(schema.dnaChangeRequests.id, String(r.body.requestId)));
    expect(req!.status).toBe("pending");
    const [dna] = await db.select().from(schema.productDnaVersions).where(eq(schema.productDnaVersions.id, s.dnaVersionId));
    expect((dna!.dna as unknown as ProductDna).identity.oneLiner).toBe("Syllabus to calendar in 15 seconds");
    // Only a UiSession accepts it (the type says so; the agent has a PatContext, which isn't one).
    expect(await acceptDnaChange(db, ui, req!.id, NOW)).toEqual({ ok: true });
    const [edited] = await db.select().from(schema.productDnaVersions).where(eq(schema.productDnaVersions.id, s.dnaVersionId));
    expect((edited!.dna as unknown as ProductDna).identity.oneLiner).toBe("Your syllabus, on your calendar");
    await client.close();
  });
});

describe("invokeTool spend limits", () => {
  const cheap = defineTool({
    name: "cheap_spend",
    description: "test",
    input: z.object({ n: z.number().int() }),
    output: z.custom<{ ran: boolean; confirmed: boolean }>(),
    effect: "spend",
    scopes: ["generate"],
    estimate: async () => 200_000,
    run: async (ctx) => ({ ran: true, confirmed: ctx.confirmed }),
  });
  const tools = toolRegistry([cheap]);

  it("runs within $0.50 a call and the token's $10 a month, then asks", async () => {
    const pat: PatContext = (await verifyPat(db, token, NOW))!;
    const ok = await invokeTool({ pat, deps, tools }, "cheap_spend", { n: 1 });
    expect(ok).toEqual({ status: "ok", result: { ran: true, confirmed: false } });

    const period = await patPeriod(db, s.workspaceId, pat.patId);
    await db.update(schema.budgetPeriods).set({ spentMicros: period.capMicros - 100_000 }).where(eq(schema.budgetPeriods.id, period.id));
    const over = await invokeTool({ pat, deps, tools }, "cheap_spend", { n: 2 });
    expect(over).toMatchObject({ status: "pending_confirmation", estimateMicros: 200_000 });

    const bad = await invokeTool({ pat, deps, tools }, "cheap_spend", { n: "x" });
    expect(bad).toMatchObject({ status: "error", code: "invalid_input" });
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.actorId, pat.patId), eq(schema.auditLog.action, "tool.cheap_spend")));
    expect(audit.map((a) => (a.data as { status: string }).status)).toEqual(["ok", "pending_confirmation", "error"]);
  });
});
