import { LaunchTemplate, type LaunchTemplateTask } from "@mkt/contracts";

/**
 * The D30 launch checklist (§2.3 Launch, M4-LC), worked backwards from the launch day (D14 of the
 * campaign by default, a Tuesday; D21). Offsets are days from the launch day unless anchor is
 * "start" (D1 of the campaign). For SyllaCal (launch Tue Jan 19 2027, D1 Jan 6) the M1 bookings
 * land on: mod requests Dec 1 (−49), ambassadors Dec 1–18 (−49..−32), pitches Dec 15 (−35),
 * BetaList Nov 15 (−65), Uneed Dec 22 (−28), PH Jan 12 (−7).
 *
 * Keys are stable: stored rows are matched to the template by key, and the gate keys are a
 * contract with the publish-time hard gate (LAUNCH_GATE_KEYS).
 */
export const LAUNCH_TEMPLATE_VERSION = "lc-v1";

const GATES = ["gate.tracking_test", "gate.pricing_visible", "gate.no_signup_wall", "gate.landing_audit"];

const t = (task: Omit<LaunchTemplateTask, "dependsOn" | "optional" | "ref"> & Partial<Pick<LaunchTemplateTask, "dependsOn" | "optional" | "ref">>): LaunchTemplateTask => ({
  dependsOn: [],
  optional: false,
  ref: { kind: "none" },
  ...task,
});

const TASKS: LaunchTemplateTask[] = [
  // ── bookings with lead times (§11 M1 manual task list) ──
  t({
    key: "book.betalist",
    title: "Submit to BetaList",
    detail: "BetaList has a long waiting list, so it needs to go in about two months early. Only if you want it: most students never see BetaList.",
    mode: "manual",
    dayOffset: -65,
    optional: true,
  }),
  t({
    key: "book.subreddit_mods",
    title: "Message the college subreddit moderators",
    detail: "Check each subreddit's rules and posting calendar, and ask the moderators if a launch post is OK and on which day. Write down the days they give you.",
    mode: "manual",
    dayOffset: -49,
  }),
  t({
    key: "kit.ambassador",
    title: "Make the campus ambassador kit",
    detail: "The app writes the ambassador invite, the rules, their personal links and the disclosure line they must use.",
    mode: "auto",
    dayOffset: -50,
    ref: { kind: "kit", kitKind: "ambassador" },
  }),
  t({
    key: "send.ambassadors",
    title: "Recruit campus ambassadors",
    detail: "Send the invite yourself to students you know at each school (the app never sends messages). Give each one their own link.",
    mode: "manual",
    dayOffset: -32,
    opensOffset: -49,
    dependsOn: ["kit.ambassador"],
  }),
  t({
    key: "kit.press",
    title: "Make the press kit and pitch drafts",
    detail: "A one-page fact sheet, screenshots in a zip, and 10 short pitches for student newsletters, campus papers and podcasts.",
    mode: "auto",
    dayOffset: -42,
    ref: { kind: "kit", kitKind: "press" },
  }),
  t({
    key: "send.press_pitches",
    title: "Send the newsletter and podcast pitches",
    detail: "Send each pitch yourself from your own email. Most newsletters plan a few weeks ahead, so this can't wait.",
    mode: "manual",
    dayOffset: -35,
    dependsOn: ["kit.press"],
  }),
  t({
    key: "kit.creator",
    title: "Make the creator brief and message templates",
    detail: "A short brief for student creators, with message templates and the paid-partnership steps they must follow.",
    mode: "auto",
    dayOffset: -38,
    ref: { kind: "kit", kitKind: "creator" },
  }),
  t({
    key: "send.creator_dms",
    title: "Message student creators",
    detail: "Send the messages yourself (the app never sends DMs). Anyone you pay or give free access must say so in the post.",
    mode: "manual",
    dayOffset: -28,
    dependsOn: ["kit.creator"],
  }),
  t({
    key: "book.uneed",
    title: "Book a Uneed launch day",
    detail: "Only if you want it. Pick launch day or the day after.",
    mode: "manual",
    dayOffset: -28,
    optional: true,
  }),
  t({
    key: "book.producthunt",
    title: "Schedule the Product Hunt launch",
    detail: "Only if you want it. Schedule it for launch day and line up the first comment.",
    mode: "manual",
    dayOffset: -7,
    optional: true,
  }),

  // ── posts (the campaign's own content) ──
  t({
    key: "content.d01_d07",
    title: "Approve the posts for days 1–7",
    detail: "Every post for the first week, approved so it goes out on its own.",
    mode: "auto",
    anchor: "start",
    dayOffset: -3,
    ref: { kind: "content_range", fromDay: 1, toDay: 7 },
  }),
  t({
    key: "content.d08_d19",
    title: "Approve the posts for days 8–19",
    detail: "The run-up to launch and launch week.",
    mode: "auto",
    anchor: "start",
    dayOffset: -3,
    ref: { kind: "content_range", fromDay: 8, toDay: 19 },
  }),
  t({
    key: "content.d20_d30",
    title: "Approve the posts for days 20–30",
    detail: "The two weeks after launch.",
    mode: "auto",
    anchor: "start",
    dayOffset: 12,
    ref: { kind: "content_range", fromDay: 20, toDay: 30 },
  }),

  // ── email ──
  t({
    key: "email.write",
    title: "Write the seasonal email",
    detail: "A short email to past buyers about the new term, with an unsubscribe link and your postal address.",
    mode: "auto",
    dayOffset: -10,
    ref: { kind: "broadcast_write" },
  }),
  t({
    key: "email.approve",
    title: "Read and approve the email",
    detail: "Check the subject line matches the email and the send time is right.",
    mode: "manual",
    dayOffset: -3,
    dependsOn: ["email.write"],
    ref: { kind: "broadcast_approve" },
  }),
  t({
    key: "email.send",
    title: "Email goes out on launch day",
    detail: "Sent on its own at the time you picked.",
    mode: "auto",
    dayOffset: 0,
    dependsOn: ["email.approve"],
    ref: { kind: "broadcast_send" },
  }),

  // ── gates (§5.4, D20): checks pass these, never a tick ──
  t({
    key: "gate.tracking_test",
    title: "Test a tracking link",
    detail: "Open the test link on your phone while logged out. It passes once your site counts the visit.",
    mode: "gate",
    dayOffset: -3,
    ref: { kind: "tracking_test" },
  }),
  t({
    key: "gate.pricing_visible",
    title: "Prices are easy to find",
    detail: "Your price is on the landing page or one click away.",
    mode: "gate",
    dayOffset: -3,
    ref: { kind: "landing_audit" },
  }),
  t({
    key: "gate.no_signup_wall",
    title: "No sign-in wall on the landing page",
    detail: "People can see the page without logging in first.",
    mode: "gate",
    dayOffset: -3,
    ref: { kind: "landing_audit" },
  }),
  t({
    key: "gate.landing_audit",
    title: "Landing page check passes",
    detail: "Loads fast, a clear sign-up button without scrolling, and tracking links survive redirects.",
    mode: "gate",
    dayOffset: -3,
    ref: { kind: "landing_audit" },
  }),

  // ── last week ──
  t({
    key: "kit.subreddit",
    title: "Make the subreddit post drafts",
    detail: "One draft per college subreddit, written to its rules. You post them yourself.",
    mode: "auto",
    dayOffset: -7,
    ref: { kind: "kit", kitKind: "subreddit" },
  }),
  t({
    key: "kit.ads_export",
    title: "Make the ads starter kit",
    detail: "Only if you want it: ad copy and images ready to paste into an ads manager later.",
    mode: "auto",
    dayOffset: -3,
    optional: true,
    ref: { kind: "kit", kitKind: "ads_export" },
  }),
  t({
    key: "kit.reply_bank",
    title: "Make the reply bank",
    detail: "Ready answers to the questions people will ask in the comments.",
    mode: "auto",
    dayOffset: -2,
    ref: { kind: "kit", kitKind: "reply_bank" },
  }),
  t({
    key: "xlinks.on",
    title: "Turn on the X links add-on",
    detail: "Turn it on in Upload-Post for launch week only, so posts on X can carry a clickable link.",
    mode: "manual",
    dayOffset: -1,
  }),

  // ── launch day ──
  t({
    key: "launch.reply_bank",
    title: "Read over your reply bank",
    detail: "Keep it open today so answers are one copy away.",
    mode: "manual",
    dayOffset: 0,
    opensOffset: -1,
    dependsOn: ["kit.reply_bank"],
  }),
  t({
    key: "launch.subreddit_posts",
    title: "Post to the college subreddits",
    detail: "Open each draft, check the rules again, copy, post, and paste the post's link back.",
    mode: "assisted",
    dayOffset: 0,
    opensOffset: 0,
    dependsOn: ["kit.subreddit", "book.subreddit_mods", ...GATES],
  }),
  t({
    key: "launch.producthunt",
    title: "Go live on Product Hunt",
    detail: "Post the first comment and answer questions through the day.",
    mode: "assisted",
    dayOffset: 0,
    opensOffset: 0,
    optional: true,
    dependsOn: ["book.producthunt", ...GATES],
  }),
  t({
    key: "launch.watch_comments",
    title: "Answer comments",
    detail: "Check every post's comments in the morning, at lunch and at night. Use the reply bank.",
    mode: "manual",
    dayOffset: 0,
    opensOffset: 0,
    dependsOn: ["launch.subreddit_posts"],
  }),
  t({
    key: "launch.numbers",
    title: "Check the live numbers",
    detail: "Visits and signups from each tracking link, so you know which post is working.",
    mode: "manual",
    dayOffset: 0,
    opensOffset: 0,
  }),

  // ── after launch (D+1..D+16) ──
  t({
    key: "after.day1_recap",
    title: "Write down what worked on launch day",
    detail: "Which posts and subreddits brought signups, and which questions came up most.",
    mode: "manual",
    dayOffset: 1,
    opensOffset: 1,
  }),
  t({
    key: "after.thank_helpers",
    title: "Thank your ambassadors and creators",
    detail: "Send them their numbers and a thank-you yourself.",
    mode: "manual",
    dayOffset: 2,
    opensOffset: 1,
    dependsOn: ["send.ambassadors"],
  }),
  t({
    key: "after.press_follow_up",
    title: "Follow up on pitches with no reply",
    detail: "One short, polite follow-up with your launch-day numbers.",
    mode: "manual",
    dayOffset: 3,
    opensOffset: 1,
    dependsOn: ["send.press_pitches"],
  }),
  t({
    key: "after.week1_recap",
    title: "Week one recap",
    detail: "Look at Results: which angle is bringing signups? Make more of the winner.",
    mode: "manual",
    dayOffset: 7,
    opensOffset: 6,
  }),
  t({
    key: "xlinks.off",
    title: "Turn off the X links add-on",
    detail: "Launch week is over. Turn it off in Upload-Post so you stop paying for it; X posts go back to the link in bio.",
    mode: "manual",
    dayOffset: 7,
    opensOffset: 7,
    dependsOn: ["xlinks.on"],
  }),
  t({
    key: "after.week2_recap",
    title: "Week two recap",
    detail: "Stop angles that get no signups and move their slots to the winner.",
    mode: "manual",
    dayOffset: 14,
    opensOffset: 13,
  }),
  t({
    key: "after.final_recap",
    title: "Wrap up the 30 days",
    detail: "Write down what brought signups and what didn't, for the next launch.",
    mode: "manual",
    dayOffset: 16,
    opensOffset: 16,
  }),
];

export const LAUNCH_TEMPLATE_LC_V1: LaunchTemplate = LaunchTemplate.parse({ version: LAUNCH_TEMPLATE_VERSION, tasks: TASKS });

const TEMPLATES: Record<string, LaunchTemplate> = { [LAUNCH_TEMPLATE_VERSION]: LAUNCH_TEMPLATE_LC_V1 };

/** The template a plan was built from (unknown versions fall back to the current one). */
export function launchTemplate(version: string = LAUNCH_TEMPLATE_VERSION): LaunchTemplate {
  return TEMPLATES[version] ?? LAUNCH_TEMPLATE_LC_V1;
}
