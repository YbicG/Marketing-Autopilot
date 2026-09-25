import { describe, expect, it } from "vitest";
import { jobDefaults } from "./queues.ts";
import { parseEntries, sanitizeLastEventId } from "./events.ts";

describe("parseEntries", () => {
  it("keeps valid events in order and drops malformed ones", () => {
    const out = parseEntries([
      ["1-0", ["e", JSON.stringify({ type: "stage_started", stage: "fetch", label: "Website" })]],
      ["2-0", ["e", JSON.stringify({ type: "not_a_real_event" })]],
      ["3-0", ["other", "x"]],
      ["4-0", ["e", JSON.stringify({ type: "run_completed" })]],
    ]);
    expect(out.map((e) => e.id)).toEqual(["1-0", "4-0"]);
  });
});

describe("sanitizeLastEventId", () => {
  it("accepts stream ids and replaces anything else with a full replay", () => {
    expect(sanitizeLastEventId("1727200000000-3")).toBe("1727200000000-3");
    expect(sanitizeLastEventId("$")).toBe("0");
    expect(sanitizeLastEventId("1-0 STREAMS x")).toBe("0");
    expect(sanitizeLastEventId(null)).toBe("0");
  });
});

describe("jobDefaults", () => {
  it("never retries paid jobs", () => {
    expect(jobDefaults(true).attempts).toBe(1);
    expect(jobDefaults(false).attempts).toBe(3);
  });
});
