import { describe, expect, it } from "vitest";
import { LAUNCH_GATE_KEYS, type LaunchTemplate } from "@mkt/contracts";
import { buildLaunchTasks, dayLabel, daysBetween, evaluateTasks, LaunchPlanError, topoOrder, weekGroup, type BuiltLaunchTask, type EvalTask, type LaunchFacts } from "./schedule.ts";
import { LAUNCH_TEMPLATE_LC_V1, launchTemplate } from "./template.ts";

const TZ = "America/New_York";
// SyllaCal (§11 M4-LC done-when): D1 Wed Jan 6 → D14 Tue Jan 19 2027.
const SYLLACAL = { launchDate: "2027-01-19", startDate: "2027-01-06", timeZone: TZ };

const build = (today: Date | string, optionalOn?: Set<string>) => buildLaunchTasks(LAUNCH_TEMPLATE_LC_V1, { ...SYLLACAL, today, optionalOn });
const byKey = (rows: BuiltLaunchTask[]) => new Map(rows.map((r) => [r.key, r]));

function evalInput(rows: BuiltLaunchTask[], over: Record<string, Partial<EvalTask>> = {}): EvalTask[] {
  return rows.map((r) => ({
    key: r.key,
    title: r.title,
    mode: r.mode,
    dueDate: r.dueDate,
    opensOn: r.opensOn,
    dependsOn: r.dependsOn,
    status: r.status,
    gate: null,
    refHint: r.refHint,
    ...over[r.key],
  }));
}
const passed = { passed: true, checkedAt: "2027-01-10T00:00:00Z", reasons: [] };
const allGatesPassed = Object.fromEntries(LAUNCH_GATE_KEYS.map((k) => [k, { gate: passed }]));

describe("D30 template", () => {
  it("is a valid DAG with the gate keys other modules rely on", () => {
    expect(() => topoOrder(LAUNCH_TEMPLATE_LC_V1.tasks)).not.toThrow();
    const keys = LAUNCH_TEMPLATE_LC_V1.tasks.map((t) => t.key);
    for (const g of LAUNCH_GATE_KEYS) {
      expect(keys).toContain(g);
      expect(LAUNCH_TEMPLATE_LC_V1.tasks.find((t) => t.key === g)!.mode).toBe("gate");
    }
    for (const k of ["kit.subreddit", "kit.ambassador", "kit.press", "kit.creator", "kit.reply_bank", "kit.ads_export"]) expect(keys).toContain(k);
    const posting = LAUNCH_TEMPLATE_LC_V1.tasks.find((t) => t.key === "launch.subreddit_posts")!;
    expect(posting.dependsOn).toEqual(expect.arrayContaining([...LAUNCH_GATE_KEYS]));
    expect(launchTemplate("unknown").version).toBe("lc-v1");
  });

  it("keeps user-facing words plain", () => {
    const words = LAUNCH_TEMPLATE_LC_V1.tasks.map((t) => `${t.title} ${t.detail}`).join(" ");
    expect(words).not.toMatch(/\b(UTM|CTA|ICP|funnel|hook|carousel|impressions|CTR|conversion)\b/i);
  });
});

describe("buildLaunchTasks: backward checklist dates (SyllaCal, America/New_York)", () => {
  const rows = byKey(build("2026-11-01"));

  it("anchors on a Tuesday launch, D14 of the campaign", () => {
    expect(new Date(Date.UTC(2027, 0, 19)).getUTCDay()).toBe(2);
    expect(daysBetween(SYLLACAL.startDate, SYLLACAL.launchDate)).toBe(13);
  });

  it("lands the M1 booking deadlines on the right days", () => {
    expect(rows.get("book.subreddit_mods")).toMatchObject({ dueDate: "2026-12-01", dayOffset: -49 });
    expect(rows.get("send.ambassadors")).toMatchObject({ dueDate: "2026-12-18", opensOn: "2026-12-01", dayOffset: -32 });
    expect(rows.get("send.press_pitches")).toMatchObject({ dueDate: "2026-12-15", dayOffset: -35 });
    expect(rows.get("book.betalist")).toMatchObject({ dueDate: "2026-11-15", optional: true });
    expect(rows.get("book.uneed")).toMatchObject({ dueDate: "2026-12-22", optional: true });
    expect(rows.get("book.producthunt")).toMatchObject({ dueDate: "2027-01-12", optional: true });
  });

  it("dates content, email, gates, launch day and after-launch tasks", () => {
    // D1–D19 approved by Jan 3 (the M4 done-when), start-anchored → launch-relative offset −16.
    expect(rows.get("content.d01_d07")).toMatchObject({ dueDate: "2027-01-03", dayOffset: -16 });
    expect(rows.get("content.d08_d19")).toMatchObject({ dueDate: "2027-01-03" });
    expect(rows.get("content.d20_d30")).toMatchObject({ dueDate: "2027-01-18" });
    expect(rows.get("email.send")!.dueDate).toBe("2027-01-19");
    for (const g of LAUNCH_GATE_KEYS) expect(rows.get(g)!.dueDate).toBe("2027-01-16");
    expect(rows.get("launch.subreddit_posts")).toMatchObject({ dueDate: "2027-01-19", opensOn: "2027-01-19", mode: "assisted" });
    expect(rows.get("xlinks.on")!.dueDate).toBe("2027-01-18");
    expect(rows.get("xlinks.off")!.dueDate).toBe("2027-01-26");
    expect(rows.get("after.final_recap")!.dueDate).toBe("2027-02-04");
  });

  it("starts optional tasks skipped unless turned on", () => {
    expect(rows.get("book.betalist")!.status).toBe("skipped");
    expect(rows.get("kit.ads_export")!.status).toBe("skipped");
    expect(rows.get("book.subreddit_mods")!.status).toBe("todo");
    const on = byKey(build("2026-11-01", new Set(["book.producthunt"])));
    expect(on.get("book.producthunt")!.status).toBe("todo");
  });

  it("flags tasks already overdue at creation instead of dropping them", () => {
    const late = build("2026-12-14");
    expect(late).toHaveLength(LAUNCH_TEMPLATE_LC_V1.tasks.length);
    const m = byKey(late);
    expect(m.get("book.subreddit_mods")!.overdueAtCreation).toBe(true);
    expect(m.get("send.press_pitches")!.overdueAtCreation).toBe(false);
    expect(m.get("book.betalist")!.overdueAtCreation).toBe(false); // skipped
  });

  it("uses the workspace's local day for 'today'", () => {
    // 22:00 on Dec 1 in New York is already Dec 2 in UTC.
    const lateEvening = new Date("2026-12-02T03:00:00Z");
    expect(byKey(build(lateEvening)).get("book.subreddit_mods")!.overdueAtCreation).toBe(false);
    const ny = buildLaunchTasks(LAUNCH_TEMPLATE_LC_V1, { ...SYLLACAL, timeZone: "UTC", today: lateEvening });
    expect(byKey(ny).get("book.subreddit_mods")!.overdueAtCreation).toBe(true);
  });

  it("returns tasks in dependency order", () => {
    const order = build("2026-11-01").map((r) => r.key);
    expect(order.indexOf("kit.press")).toBeLessThan(order.indexOf("send.press_pitches"));
    expect(order.indexOf("gate.landing_audit")).toBeLessThan(order.indexOf("launch.subreddit_posts"));
  });

  it("rejects bad dates", () => {
    expect(() => buildLaunchTasks(LAUNCH_TEMPLATE_LC_V1, { ...SYLLACAL, startDate: "2027-01-20", today: "2026-11-01" })).toThrow(LaunchPlanError);
    expect(() => buildLaunchTasks(LAUNCH_TEMPLATE_LC_V1, { ...SYLLACAL, launchDate: "Jan 19", today: "2026-11-01" })).toThrow(LaunchPlanError);
  });
});

describe("dependency checks", () => {
  const base = { title: "x", detail: "", mode: "manual" as const, dayOffset: 0, optional: false, ref: { kind: "none" as const } };
  const tpl = (tasks: { key: string; dependsOn: string[] }[]): LaunchTemplate => ({ version: "t", tasks: tasks.map((t) => ({ ...base, ...t })) });
  const b = (template: LaunchTemplate) => () => buildLaunchTasks(template, { ...SYLLACAL, today: "2026-11-01" });

  it("throws on cycles, unknown keys, self-dependencies and duplicates", () => {
    expect(b(tpl([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["c"] }, { key: "c", dependsOn: ["a"] }]))).toThrow(/loop/);
    expect(b(tpl([{ key: "a", dependsOn: ["nope"] }]))).toThrow(/isn't in the checklist/);
    expect(b(tpl([{ key: "a", dependsOn: ["a"] }]))).toThrow(/itself/);
    expect(b(tpl([{ key: "a", dependsOn: [] }, { key: "a", dependsOn: [] }]))).toThrow(/twice/);
    expect(b(tpl([{ key: "a", dependsOn: [] }, { key: "b", dependsOn: ["a"] }]))).not.toThrow();
  });
});

describe("evaluateTasks", () => {
  const rows = build("2026-11-01");
  const at = (evals: ReturnType<typeof evaluateTasks>, key: string) => evals.find((e) => e.key === key)!;
  const launchDayDone = Object.fromEntries(
    ["kit.subreddit", "book.subreddit_mods", "kit.reply_bank", "book.producthunt"].map((k) => [k, { status: "done" as const }]),
  );

  it("gates block their dependents until they pass", () => {
    const blocked = evaluateTasks(evalInput(rows, launchDayDone), {}, "2027-01-19");
    const posting = at(blocked, "launch.subreddit_posts");
    expect(posting.status).toBe("todo");
    expect(posting.blockedBy).toEqual(expect.arrayContaining([...LAUNCH_GATE_KEYS]));
    expect(posting.reasons[0]).toContain("Test a tracking link");
    expect(at(blocked, "launch.watch_comments").status).toBe("todo");

    const open = evaluateTasks(evalInput(rows, { ...launchDayDone, ...allGatesPassed }), {}, "2027-01-19");
    expect(at(open, "launch.subreddit_posts")).toMatchObject({ status: "ready", blockedBy: [] });
  });

  it("a gate is done iff its check passed; a failing gate sends dependents back to todo", () => {
    const stale = { gate: { passed: false, checkedAt: "x", reasons: ["Prices are hidden."] }, status: "done" as const };
    const evals = evaluateTasks(
      evalInput(rows, { ...launchDayDone, ...allGatesPassed, "gate.pricing_visible": stale, "launch.subreddit_posts": { status: "ready" } }),
      {},
      "2027-01-19",
    );
    expect(at(evals, "gate.pricing_visible")).toMatchObject({ status: "ready", reasons: ["Prices are hidden."] });
    expect(at(evals, "gate.tracking_test").status).toBe("done");
    expect(at(evals, "launch.subreddit_posts").status).toBe("todo");
    // A skipped gate still isn't passed.
    const skipped = evaluateTasks(evalInput(rows, { "gate.landing_audit": { status: "skipped" } }), {}, "2027-01-10");
    expect(at(skipped, "gate.landing_audit")).toMatchObject({ status: "ready", reasons: ["Not checked yet."] });
  });

  it("opens tasks only inside their window", () => {
    const early = evaluateTasks(evalInput(rows, { ...launchDayDone, ...allGatesPassed }), {}, "2027-01-17");
    expect(at(early, "launch.subreddit_posts").status).toBe("todo");
    expect(at(early, "launch.subreddit_posts").reasons[0]).toContain("Starts 2027-01-19");
    const amb = evaluateTasks(evalInput(rows, { "kit.ambassador": { status: "done" } }), {}, "2026-11-20");
    expect(at(amb, "send.ambassadors").status).toBe("todo");
    const amb2 = evaluateTasks(evalInput(rows, { "kit.ambassador": { status: "done" } }), {}, "2026-12-01");
    expect(at(amb2, "send.ambassadors").status).toBe("ready");
  });

  it("skipped dependencies don't block; done and skipped stay put", () => {
    const evals = evaluateTasks(evalInput(rows, { ...allGatesPassed, "kit.subreddit": { status: "done" }, "book.subreddit_mods": { status: "skipped" } }), {}, "2027-01-19");
    expect(at(evals, "launch.subreddit_posts").status).toBe("ready");
    expect(at(evals, "book.subreddit_mods").status).toBe("skipped");
    expect(at(evals, "book.betalist").status).toBe("skipped");
  });

  it("content tasks follow the campaign's posts", () => {
    const facts = (f: NonNullable<LaunchFacts["contentRanges"]>[string]): LaunchFacts => ({ contentRanges: { "content.d01_d07": f } });
    const e = (f: LaunchFacts) => at(evaluateTasks(evalInput(rows), f, "2026-12-20"), "content.d01_d07");
    expect(e({})).toMatchObject({ status: "ready", reasons: ["No posts planned for these days yet."] });
    expect(e(facts({ total: 10, approved: 4, published: 0 }))).toMatchObject({ status: "ready", reasons: ["4 of 10 approved."] });
    expect(e(facts({ total: 10, approved: 10, published: 0 })).status).toBe("scheduled");
    expect(e(facts({ total: 10, approved: 10, published: 10 })).status).toBe("done");
    // Scheduled isn't overdue; a half-approved range past its date is.
    expect(at(evaluateTasks(evalInput(rows), facts({ total: 2, approved: 2, published: 0 }), "2027-01-05"), "content.d01_d07").overdue).toBe(false);
    expect(at(evaluateTasks(evalInput(rows), facts({ total: 2, approved: 1, published: 0 }), "2027-01-05"), "content.d01_d07").overdue).toBe(true);
  });

  it("kit and email tasks follow their rows", () => {
    const kits: LaunchFacts = { kits: { press: { id: "k1", status: "ready" }, creator: { id: "k2", status: "generating" }, ambassador: { id: "k3", status: "needs_you", needsYouReason: "Add the disclosure line." } } };
    const ev = evaluateTasks(evalInput(rows), kits, "2026-11-20");
    expect(at(ev, "kit.press")).toMatchObject({ status: "done", refPatch: { kitId: "k1" } });
    expect(at(ev, "kit.creator").status).toBe("scheduled");
    expect(at(ev, "kit.ambassador").reasons).toEqual(["Add the disclosure line."]);
    // send.press_pitches waits on kit.press, which became done in the same pass.
    expect(at(ev, "send.press_pitches").status).toBe("ready");

    const mail = (status: string, hasBody = true) => evaluateTasks(evalInput(rows), { broadcast: { id: "b1", status, hasBody } }, "2027-01-19");
    expect(at(mail("draft"), "email.write")).toMatchObject({ status: "done", refPatch: { broadcastId: "b1" } });
    expect(at(mail("draft", false), "email.write").status).toBe("ready");
    expect(at(mail("draft"), "email.approve").status).toBe("ready");
    expect(at(mail("scheduled_at_resend"), "email.approve").status).toBe("done");
    expect(at(mail("scheduled_at_resend"), "email.send").status).toBe("scheduled");
    expect(at(mail("sent"), "email.send").status).toBe("done");
  });
});

describe("labels", () => {
  it("names days and weeks relative to launch", () => {
    expect(dayLabel(0)).toBe("Launch day");
    expect(dayLabel(-1)).toBe("1 day before launch");
    expect(dayLabel(3)).toBe("3 days after launch");
    expect(weekGroup(-1).label).toBe("1 week before");
    expect(weekGroup(-7).label).toBe("1 week before");
    expect(weekGroup(-8).label).toBe("2 weeks before");
    expect(weekGroup(-49)).toMatchObject({ label: "7 weeks before", fromOffset: -49, toOffset: -43 });
    expect(weekGroup(0).label).toBe("Launch day");
    expect(weekGroup(3).label).toBe("Launch week");
    expect(weekGroup(7).label).toBe("1 week after");
    expect(weekGroup(16).label).toBe("2 weeks after");
  });
});
