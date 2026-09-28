import { describe, expect, it } from "vitest";
import { projectStage } from "./projects.ts";

const now = new Date("2026-09-28T12:00:00Z");
const none = { hasProfile: false, hasCampaign: false, hasContent: false, hasPlannedOrPublished: false, firstPublishedAt: null };

describe("projectStage", () => {
  it("counts stages in order", () => {
    expect(projectStage(none, now)).toBe(0);
    expect(projectStage({ ...none, hasProfile: true }, now)).toBe(1);
    expect(projectStage({ ...none, hasProfile: true, hasCampaign: true, hasContent: true }, now)).toBe(3);
  });

  it("stops at the first missing stage", () => {
    expect(projectStage({ ...none, hasCampaign: true, hasContent: true, hasPlannedOrPublished: true }, now)).toBe(0);
  });

  it("starts learning three days after the first post", () => {
    const posting = { hasProfile: true, hasCampaign: true, hasContent: true, hasPlannedOrPublished: true };
    expect(projectStage({ ...posting, firstPublishedAt: new Date("2026-09-27T12:00:00Z") }, now)).toBe(4);
    expect(projectStage({ ...posting, firstPublishedAt: new Date("2026-09-25T12:00:00Z") }, now)).toBe(5);
  });
});
