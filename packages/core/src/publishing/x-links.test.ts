import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { seedWorkspace } from "./test-fixtures.ts";
import {
  linkKinds,
  setXLinksWindow,
  suggestedXLinksWindow,
  validateXLinksWindow,
  xLinksAllowedOn,
  xLinksAtPublish,
  xLinksBlockMessage,
} from "./x-links.ts";

const W = { xLinksFrom: "2027-01-16", xLinksUntil: "2027-01-22" };
const NONE = { xLinksFrom: null, xLinksUntil: null };

describe("xLinksAllowedOn (generation side)", () => {
  it("inside the window, inclusive at both ends", () => {
    expect(xLinksAllowedOn(W, "2027-01-16", "2027-01-19")).toBe(true);
    expect(xLinksAllowedOn(W, "2027-01-22", "2027-01-19")).toBe(true);
    expect(xLinksAllowedOn(W, "2027-01-15", "2027-01-19")).toBe(false);
    expect(xLinksAllowedOn(W, "2027-01-23", "2027-01-19")).toBe(false);
  });
  it("a set window wins over the launch-day fallback", () => {
    const early = { xLinksFrom: "2027-01-01", xLinksUntil: "2027-01-03" };
    expect(xLinksAllowedOn(early, "2027-01-19", "2027-01-19")).toBe(false);
    expect(xLinksAllowedOn(early, "2027-01-02", "2027-01-19")).toBe(true);
  });
  it("unset: launch day ±3, across a month end", () => {
    expect(xLinksAllowedOn(NONE, "2027-01-19", "2027-01-19")).toBe(true);
    expect(xLinksAllowedOn(NONE, "2027-01-16", "2027-01-19")).toBe(true);
    expect(xLinksAllowedOn(NONE, "2027-01-22", "2027-01-19")).toBe(true);
    expect(xLinksAllowedOn(NONE, "2027-01-15", "2027-01-19")).toBe(false);
    expect(xLinksAllowedOn(NONE, "2027-02-01", "2027-01-30")).toBe(true);
  });
  it("no window, no launch date, or no day: no links", () => {
    expect(xLinksAllowedOn(NONE, "2027-01-19", null)).toBe(false);
    expect(xLinksAllowedOn(W, null, "2027-01-19")).toBe(false);
    // Half a window counts as unset.
    expect(xLinksAllowedOn({ xLinksFrom: "2027-01-16", xLinksUntil: null }, "2027-01-19", "2027-01-19")).toBe(true);
  });
});

describe("xLinksAtPublish (publish side)", () => {
  const win = { from: "2027-01-16", until: "2027-01-22" };
  const token = { token: true, raw: false };
  const raw = { token: false, raw: true };
  const none = { token: false, raw: false };
  it("inside the window links are live", () => {
    expect(xLinksAtPublish({ window: win, day: "2027-01-19", connectionAddon: false, links: token })).toEqual({ linksAllowed: true, block: null });
  });
  it("outside the window any link blocks with the plain reason", () => {
    const r = xLinksAtPublish({ window: win, day: "2027-01-25", connectionAddon: true, links: token });
    expect(r.block).toBe("The X links add-on isn't on for Mon, Jan 25. Remove the link or set the add-on dates in Settings.");
    expect(xLinksAtPublish({ window: win, day: "2027-01-25", connectionAddon: false, links: raw }).block).toBe(xLinksBlockMessage("2027-01-25"));
    expect(xLinksAtPublish({ window: win, day: "2027-01-25", connectionAddon: false, links: none })).toEqual({ linksAllowed: false, block: null });
  });
  it("unset window: a token becomes link in bio, a typed address blocks unless the connection flag is on", () => {
    expect(xLinksAtPublish({ window: null, day: "2027-01-19", connectionAddon: false, links: token })).toEqual({ linksAllowed: false, block: null });
    expect(xLinksAtPublish({ window: null, day: "2027-01-19", connectionAddon: false, links: raw }).block).toMatch(/isn't on for/);
    expect(xLinksAtPublish({ window: null, day: "2027-01-19", connectionAddon: true, links: raw })).toEqual({ linksAllowed: true, block: null });
  });
  it("linkKinds finds tokens and typed addresses", () => {
    expect(linkKinds(["Out now {{link:landing}}"])).toEqual({ token: true, raw: false });
    expect(linkKinds(["see https://x.com/a"])).toEqual({ token: false, raw: true });
    expect(linkKinds(["part one", "www.site.com"])).toEqual({ token: false, raw: true });
    expect(linkKinds(["no links"])).toEqual({ token: false, raw: false });
  });
});

describe("setXLinksWindow", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("validates from ≤ until, real dates and ≤ 31 days", () => {
    expect(validateXLinksWindow({ from: "2027-01-16", until: "2027-01-22" })).toBeNull();
    expect(validateXLinksWindow({ from: "2027-01-16", until: "2027-01-16" })).toBeNull();
    expect(validateXLinksWindow({ from: "2027-01-22", until: "2027-01-16" })).toMatch(/before the start/);
    expect(validateXLinksWindow({ from: "2027-02-30", until: "2027-03-02" })).toMatch(/Pick a start/);
    expect(validateXLinksWindow({ from: "2027-01-01", until: "2027-01-31" })).toBeNull();
    expect(validateXLinksWindow({ from: "2027-01-01", until: "2027-02-01" })).toMatch(/at most 31 days/);
    expect(suggestedXLinksWindow("2027-01-19")).toEqual({ from: "2027-01-16", until: "2027-01-22" });
  });

  it("writes the product and an audit row; clears with null; refuses other workspaces", async () => {
    const s = await seedWorkspace(db);
    const bad = await setXLinksWindow(db, s.workspaceId, s.productId, { from: "2027-01-22", until: "2027-01-16" }, "user-1");
    expect(bad.ok).toBe(false);

    const r = await setXLinksWindow(db, s.workspaceId, s.productId, { from: "2027-01-16", until: "2027-01-22" }, "user-1");
    expect(r).toEqual({ ok: true, window: { from: "2027-01-16", until: "2027-01-22" } });
    const [p] = await db.select().from(schema.products).where(eq(schema.products.id, s.productId));
    expect(p).toMatchObject({ xLinksFrom: "2027-01-16", xLinksUntil: "2027-01-22" });

    expect(await setXLinksWindow(db, s.workspaceId, s.productId, null, "user-1")).toEqual({ ok: true, window: null });
    const [p2] = await db.select().from(schema.products).where(eq(schema.products.id, s.productId));
    expect(p2).toMatchObject({ xLinksFrom: null, xLinksUntil: null });

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.workspaceId, s.workspaceId), eq(schema.auditLog.action, "product.x_links_window")));
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.actorId)).toEqual(["user-1", "user-1"]);

    const other = await seedWorkspace(db);
    const cross = await setXLinksWindow(db, other.workspaceId, s.productId, { from: "2027-01-16", until: "2027-01-22" }, "user-1");
    expect(cross.ok).toBe(false);
  });
});
