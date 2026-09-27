import { describe, expect, it } from "vitest";
import { KitInputs } from "@mkt/contracts";
import { draftFromInputs, inputsFor, kindFromSlug, kindSlug, kitSummary, launchDayLabel, searchReplies, writeAllKinds } from "./kit-model";

const blank = draftFromInputs({});

describe("kit inputs as typed", () => {
  it("turns what the person typed into KitInputs for just the kinds being written", () => {
    const d = {
      ...blank,
      communities: "r/college, /r/UCLA/\nstudents\ncollege",
      dueDate: "2027-01-19",
      ambassadors: "Maya Chen\nJordan Lee, jordan-ucla\n\n",
      reward: "  A free year  ",
      targets: [
        { outlet: "The Daily Bruin", kind: "campus_paper" as const, contactName: "Ana", email: "ana@example.edu" },
        { outlet: " ", kind: "podcast" as const, contactName: "", email: "" },
      ],
      offer: "",
      extraQuestions: "Does it work with Outlook?\n\nIs it private?",
    };
    const all = inputsFor(["subreddit", "ambassador", "press", "creator", "reply_bank", "ads_export"], d);
    expect(all.error).toBeNull();
    expect(all.inputs).toEqual({
      subreddit: { communities: ["college", "UCLA", "students"], dueDate: "2027-01-19" },
      ambassador: { ambassadors: [{ name: "Maya Chen", ref: null }, { name: "Jordan Lee", ref: "jordan-ucla" }], reward: "A free year" },
      press: { targets: [{ outlet: "The Daily Bruin", kind: "campus_paper", contactName: "Ana", email: "ana@example.edu" }] },
      creator: { offer: null },
      reply_bank: { extraQuestions: ["Does it work with Outlook?", "Is it private?"] },
    });
    expect(KitInputs.safeParse(all.inputs).success).toBe(true);
    // Round trip back into the form.
    expect(inputsFor(["subreddit", "ambassador"], draftFromInputs(all.inputs!)).inputs).toEqual({ subreddit: all.inputs!.subreddit, ambassador: all.inputs!.ambassador });
    // Only the kinds being written are checked.
    expect(inputsFor(["reply_bank"], { ...d, communities: "not a sub!" }).error).toBeNull();
  });

  it("says what to fix in a plain sentence", () => {
    expect(inputsFor(["subreddit"], { ...blank, communities: "college, a" }).error).toMatch(/"a" isn't a community name/);
    expect(inputsFor(["ambassador"], { ...blank, ambassadors: "Maya, not ok!" }).error).toMatch(/link code/);
    expect(inputsFor(["press"], { ...blank, targets: [{ outlet: "Pod", kind: "podcast", contactName: "", email: "nope" }] }).error).toMatch(/Check the email for Pod/);
    expect(inputsFor(["subreddit"], { ...blank, communities: Array.from({ length: 13 }, (_, i) => `sub${i}`).join("\n") }).error).toMatch(/12/);
  });
});

describe("kit page helpers", () => {
  it("maps kinds to URL segments and back", () => {
    expect(kindSlug("reply_bank")).toBe("reply-bank");
    expect(kindFromSlug("reply-bank")).toBe("reply_bank");
    expect(kindFromSlug("ads-export")).toBe("ads_export");
    expect(kindFromSlug("nope")).toBeNull();
  });

  it("searches the reply bank by every word, in question or reply", () => {
    const r = [
      { trigger: "Is it a subscription?", reply: "No, $4.99 once." },
      { trigger: "Does it work with Outlook?", reply: "Yes, and Google Calendar." },
    ];
    expect(searchReplies(r, "")).toHaveLength(2);
    expect(searchReplies(r, "outlook")).toEqual([r[1]]);
    expect(searchReplies(r, "google yes")).toEqual([r[1]]);
    expect(searchReplies(r, "once SUBSCRIPTION")).toEqual([r[0]]);
    expect(searchReplies(r, "refund")).toEqual([]);
  });

  it("summarises bodies and picks what Write all covers", () => {
    expect(kitSummary("reply_bank", { replies: [1, 2, 3] })).toBe("3 replies");
    expect(kitSummary("press", { pitches: new Array(10).fill(0), facts: [1] })).toBe("10 pitches · 1 fact");
    expect(kitSummary("ads_export", { concepts: [1, 2, 3], platforms: { meta: { skipped: null }, apple_search_ads: { skipped: "web product" } } })).toBe("3 ideas · 1 platform");
    expect(kitSummary("subreddit", { schemaVersion: 1 })).toBeNull();
    expect(kitSummary("creator", null)).toBeNull();
    expect(
      writeAllKinds([
        { kind: "subreddit", status: "missing" },
        { kind: "press", status: "failed" },
        { kind: "creator", status: "needs_you" },
        { kind: "reply_bank", status: "ready" },
        { kind: "ambassador", status: "generating" },
      ]),
    ).toEqual(["subreddit", "press"]);
  });

  it("shows launch day as a calendar date", () => {
    expect(launchDayLabel("2027-01-19")).toBe("Tue, Jan 19, 2027");
    expect(launchDayLabel("soon")).toBe("soon");
  });
});
