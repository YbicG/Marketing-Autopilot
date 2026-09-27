// §8 "Assisted-only venues" (§5.8 step 9): Reddit, HN, Product Hunt, Discord and the directories
// are never posted to by the app. The registry refuses an adapter that claims one, and the
// publish path refuses a post for one even if a row somehow says "api".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ASSISTED_ONLY_TARGETS, definePublisher, isAssistedOnly, uploadPost, type PublisherAdapter } from "@mkt/providers";
import { schema, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { handlePublishDue } from "../publishing/due.ts";
import { fakeAdapter } from "../publishing/test-fixtures.ts";
import { approvedPost, postRow, world } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("§8 Assisted-only venues", () => {
  it("the list covers the venues §5.8 names", () => {
    expect([...ASSISTED_ONLY_TARGETS]).toEqual(expect.arrayContaining(["reddit", "hackernews", "producthunt", "indiehackers", "discord", "directory"]));
    expect(isAssistedOnly("Reddit")).toBe(true);
    expect(isAssistedOnly("threads")).toBe(false);
  });

  it("no registered publisher posts to one", () => {
    expect(uploadPost.platforms.filter((p) => isAssistedOnly(p))).toEqual([]);
  });

  it("an adapter that claims one is refused at registration", () => {
    const bad = { ...fakeAdapter(), meta: { id: "sneaky", kind: "publish", requiredSecrets: [] }, platforms: ["x", "reddit"] } as unknown as PublisherAdapter;
    expect(() => definePublisher(bad)).toThrow("publisher sneaky claims assisted-only venues: reddit");
  });

  it("publish time: a post for an assisted-only venue is never sent", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await db.update(schema.posts).set({ platform: "reddit" }).where(eq(schema.posts.id, id));
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
    expect((await postRow(db, id)).lastError).toBe("This venue is post-it-yourself only. Use Copy & open.");
  });

  it("publish time: a post in assisted mode is never sent, whatever the platform", async () => {
    const w = await world(db);
    const id = await approvedPost(w);
    await db.update(schema.posts).set({ mode: "assisted" }).where(eq(schema.posts.id, id));
    expect(await handlePublishDue(w.deps, { postId: id, generation: 1 })).toBe("failed");
    expect(w.adapter.submits).toHaveLength(0);
  });
});
