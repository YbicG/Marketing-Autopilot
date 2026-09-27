import { z } from "zod";

// M4-LC Launch tab (§2.3 Launch, §4.3 launch_tasks): the D30 checklist, its gates and the landing audit.

export const LaunchTaskMode = z.enum(["auto", "assisted", "manual", "gate"]);
export type LaunchTaskMode = z.infer<typeof LaunchTaskMode>;

/** UI tag per mode (§2.3: "tagged Auto/Assisted/You/Gate"). */
export const LAUNCH_MODE_LABELS: Record<LaunchTaskMode, string> = { auto: "Auto", assisted: "Assisted", manual: "You", gate: "Gate" };

export const LaunchTaskStatus = z.enum(["todo", "ready", "scheduled", "done", "skipped"]);
export type LaunchTaskStatus = z.infer<typeof LaunchTaskStatus>;

/**
 * The gate keys other modules rely on. CONTRACT (B4's publish-time hard gate): a launch_tasks row
 * with mode "gate" counts as passed iff its status is "done", and a gate is "done" iff gate.passed.
 */
export const LAUNCH_GATE_KEYS = ["gate.tracking_test", "gate.pricing_visible", "gate.no_signup_wall", "gate.landing_audit"] as const;
export const LaunchGateKey = z.enum(LAUNCH_GATE_KEYS);
export type LaunchGateKey = z.infer<typeof LaunchGateKey>;

/**
 * What a template task points at, so the evaluator knows where its status comes from:
 * - content_range: the campaign's posts for days fromDay..toDay (auto: scheduled once all are approved)
 * - kit: a launch kit piece (auto: done once the kit is ready)
 * - broadcast_write / broadcast_approve / broadcast_send: the seasonal email
 * - tracking_test / landing_audit: gates passed by checks only
 * - none: a plain checklist item the person ticks
 */
export const LaunchRefKind = z.enum([
  "none",
  "content_range",
  "kit",
  "broadcast_write",
  "broadcast_approve",
  "broadcast_send",
  "tracking_test",
  "landing_audit",
]);
export type LaunchRefKind = z.infer<typeof LaunchRefKind>;

export const LaunchKitKindRef = z.enum(["subreddit", "ambassador", "press", "creator", "reply_bank", "ads_export"]);

export const LaunchRefHint = z.object({
  kind: LaunchRefKind,
  kitKind: LaunchKitKindRef.optional(),
  /** Campaign days (1-based, D1 = start date) for content_range. */
  fromDay: z.number().int().min(1).optional(),
  toDay: z.number().int().min(1).optional(),
});
export type LaunchRefHint = z.infer<typeof LaunchRefHint>;

export const LaunchTemplateTask = z.object({
  key: z.string().regex(/^[a-z0-9_.]+$/),
  title: z.string().min(1),
  detail: z.string(),
  mode: LaunchTaskMode,
  /** Days from the anchor (negative = before). Stored rows always hold the launch-relative offset. */
  dayOffset: z.number().int(),
  /** "launch" (default) = the launch day; "start" = D1 of the campaign. */
  anchor: z.enum(["launch", "start"]).optional(),
  /** When the task can start (same anchor as dayOffset). Omitted = any time. */
  opensOffset: z.number().int().optional(),
  dependsOn: z.array(z.string()),
  /** Optional tasks (BetaList, Uneed, PH, ads kit) start "skipped" unless turned on (open question 4). */
  optional: z.boolean(),
  ref: LaunchRefHint,
});
export type LaunchTemplateTask = z.infer<typeof LaunchTemplateTask>;

export const LaunchTemplate = z.object({
  version: z.string(),
  tasks: z.array(LaunchTemplateTask),
});
export type LaunchTemplate = z.infer<typeof LaunchTemplate>;

/** launch_tasks.gate. */
export const LaunchGateResult = z.object({
  passed: z.boolean(),
  checkedAt: z.string(),
  reasons: z.array(z.string()),
});
export type LaunchGateResult = z.infer<typeof LaunchGateResult>;

// ── landing audit (§5.4) ──

export const LANDING_CHECK_IDS = ["load_time", "signup_button", "pricing_visible", "no_signup_wall", "share_preview", "analytics", "tracking_survives"] as const;
export const LandingCheckId = z.enum(LANDING_CHECK_IDS);
export type LandingCheckId = z.infer<typeof LandingCheckId>;

export const LandingAuditCheck = z.object({
  id: LandingCheckId,
  label: z.string(),
  passed: z.boolean(),
  /** "gate" checks must pass for gate.landing_audit; "warn" checks are advice. */
  severity: z.enum(["gate", "warn"]),
  detail: z.string().optional(),
});
export type LandingAuditCheck = z.infer<typeof LandingAuditCheck>;

export const LandingAuditView = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(["queued", "running", "done", "failed"]),
  passed: z.boolean().nullable(),
  checks: z.array(LandingAuditCheck),
  screenshotAssetIds: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type LandingAuditView = z.infer<typeof LandingAuditView>;

// ── views the Launch tab renders ──

export const LaunchTaskView = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  mode: LaunchTaskMode,
  modeLabel: z.string(),
  dayOffset: z.number().int(),
  /** "3 days before launch", "Launch day", "2 days after launch". */
  dayLabel: z.string(),
  dueDate: z.string(),
  status: LaunchTaskStatus,
  optional: z.boolean(),
  overdue: z.boolean(),
  /** Titles of unfinished tasks this one waits on. */
  blockedBy: z.array(z.string()),
  /** Plain-English reasons (a gate's failed checks, "No posts planned for these days yet"...). */
  reasons: z.array(z.string()),
  ref: z.record(z.string(), z.string()).nullable(),
  gate: LaunchGateResult.nullable(),
  doneAt: z.string().nullable(),
  /** false for gates (checks pass them) and for tasks whose status comes from the app. */
  canTick: z.boolean(),
});
export type LaunchTaskView = z.infer<typeof LaunchTaskView>;

export const LaunchTaskGroup = z.object({
  /** "7 weeks before", "1 week before", "Launch day", "Launch week", "2 weeks after". */
  label: z.string(),
  fromOffset: z.number().int(),
  toOffset: z.number().int(),
  tasks: z.array(LaunchTaskView),
});
export type LaunchTaskGroup = z.infer<typeof LaunchTaskGroup>;

export const LaunchGateSummary = z.object({
  planId: z.string().nullable(),
  allPassed: z.boolean(),
  gates: z.array(
    z.object({
      key: z.string(),
      taskId: z.string(),
      title: z.string(),
      passed: z.boolean(),
      reasons: z.array(z.string()),
      checkedAt: z.string().nullable(),
    }),
  ),
});
export type LaunchGateSummary = z.infer<typeof LaunchGateSummary>;

export const LaunchCountdown = z.object({
  launchDate: z.string(),
  today: z.string(),
  /** Days until launch (0 on launch day, negative after). */
  daysToLaunch: z.number().int(),
  isLaunchDay: z.boolean(),
  isPast: z.boolean(),
});
export type LaunchCountdown = z.infer<typeof LaunchCountdown>;

export const LaunchView = z.object({
  plan: z.object({
    id: z.string(),
    productId: z.string(),
    campaignId: z.string().nullable(),
    startDate: z.string(),
    launchDate: z.string(),
    status: z.enum(["draft", "active", "done"]),
    templateVersion: z.string(),
  }),
  countdown: LaunchCountdown,
  groups: z.array(LaunchTaskGroup),
  gates: LaunchGateSummary,
  overdue: z.array(LaunchTaskView),
  /** M4 done-when: ≥90% of the Auto items for D1–D19 approved by `dueDate` (D1 − 3). */
  autoApproval: z.object({
    fromDay: z.number().int(),
    toDay: z.number().int(),
    approved: z.number().int(),
    total: z.number().int(),
    pct: z.number(),
    targetPct: z.number(),
    dueDate: z.string(),
    onTrack: z.boolean(),
  }),
  counts: z.object({ total: z.number().int(), done: z.number().int(), skipped: z.number().int(), open: z.number().int() }),
  latestAudit: LandingAuditView.nullable(),
});
export type LaunchView = z.infer<typeof LaunchView>;

export const LaunchDayPost = z.object({
  postId: z.string(),
  platform: z.string(),
  scheduledAt: z.string(),
  state: z.string(),
  publishedAt: z.string().nullable(),
  /** The live post: the comment deep link on launch day. */
  platformUrl: z.string().nullable(),
});
export type LaunchDayPost = z.infer<typeof LaunchDayPost>;

export const LaunchDayNumbers = z.object({
  day: z.string(),
  postsPublished: z.number().int(),
  views: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  linkClicks: z.number().int().nullable(),
  visits: z.number().int().nullable(),
  signups: z.number().int().nullable(),
  purchases: z.number().int().nullable(),
});
export type LaunchDayNumbers = z.infer<typeof LaunchDayNumbers>;

export const LaunchDayView = z.object({
  planId: z.string(),
  countdown: LaunchCountdown,
  todayTasks: z.array(LaunchTaskView),
  gates: LaunchGateSummary,
  nextPostsToday: z.array(LaunchDayPost),
  publishedToday: z.array(LaunchDayPost),
  /** The reply bank kit (its body belongs to the kit module). */
  replyBank: z.object({ kitId: z.string(), status: z.string() }).nullable(),
  yesterday: LaunchDayNumbers,
  today: LaunchDayNumbers,
});
export type LaunchDayView = z.infer<typeof LaunchDayView>;
