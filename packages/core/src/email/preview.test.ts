import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { previewBroadcast } from "./preview.ts";

let db: Db;
let close: () => Promise<void>;
let ws: string;
let broadcastId: string;
const NOW = new Date("2026-12-20T12:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ws = uuidv7();
  const productId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t", timezone: "America/New_York" });
  await db.insert(schema.products).values({
    id: productId,
    workspaceId: ws,
    slug: "syllacal",
    name: "SyllaCal",
    urls: { website: "https://syllacal.com/" },
    emailSettings: {
      fromName: "CJ",
      fromEmail: "cj@syllacal.com",
      postalAddress: "PO Box 123, Austin, TX 78701",
      audienceId: "seg_buyers",
      consentSource: "you bought SyllaCal",
      euConsentAck: true,
    },
  });
  broadcastId = uuidv7();
  await db.insert(schema.emailBroadcasts).values({
    id: broadcastId,
    workspaceId: ws,
    productId,
    name: "January",
    subject: "Your spring semester, sorted",
    body: "Thanks for using SyllaCal.\n\nGet set up: {{link:landing}}",
    status: "approved",
    audienceId: "seg_buyers",
    scheduledAt: new Date("2027-01-06T15:00:00Z"),
  });
});
afterAll(() => close());

describe("previewBroadcast", () => {
  it("renders unsaved text with the footer and escapes it, without writing", async () => {
    const r = await previewBroadcast(db, ws, broadcastId, { subject: "New term, new calendar", body: "Hello <b>there</b>\n\nSee {{link:landing}}" }, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.html).toContain("New term, new calendar");
    expect(r.preview.html).toContain("&lt;b&gt;there&lt;/b&gt;");
    expect(r.preview.html).not.toContain("<b>there</b>");
    expect(r.preview.html).toContain("PO Box 123");
    expect(r.preview.text).toContain("syllacal.com");
    const [row] = await db.select().from(schema.emailBroadcasts).where(eq(schema.emailBroadcasts.id, broadcastId));
    expect(row?.subject).toBe("Your spring semester, sorted");
    expect(row?.status).toBe("approved");
  });

  it("reports the same checks the editor would store", async () => {
    const r = await previewBroadcast(db, ws, broadcastId, { subject: "Re: last chance" }, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const codes = r.preview.issues.map((i) => i.code);
    expect(codes).toContain("subject_fake_reply");
  });

  it("refuses other workspaces and bad input", async () => {
    expect((await previewBroadcast(db, uuidv7(), broadcastId, {}, { now: NOW })).ok).toBe(false);
    expect((await previewBroadcast(db, ws, broadcastId, { subject: "x".repeat(500) }, { now: NOW })).ok).toBe(false);
  });
});
