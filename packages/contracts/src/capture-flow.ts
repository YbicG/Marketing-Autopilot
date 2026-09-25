import { z } from "zod";

// ── Recorded demo flows (M3b, §5.6 step 1, D26) ──
// A flow is a short list of steps the capture Chromium replays against the product's trusted origin.
// Steps are data only: the recorder never follows page text as instructions, and every click is
// re-checked against the action denylist at click time (packages/core/src/capture/guard.ts).

const MAX_TEXT = 200;

/** How a step finds an element. Exactly one strategy per target. */
export const CaptureTarget = z.discriminatedUnion("by", [
  z.object({ by: z.literal("text"), text: z.string().min(1).max(MAX_TEXT) }),
  z.object({ by: z.literal("role"), role: z.string().min(1).max(40), name: z.string().min(1).max(MAX_TEXT) }),
  z.object({ by: z.literal("label"), label: z.string().min(1).max(MAX_TEXT) }),
  z.object({ by: z.literal("placeholder"), placeholder: z.string().min(1).max(MAX_TEXT) }),
  z.object({ by: z.literal("selector"), selector: z.string().min(1).max(300) }),
]);
export type CaptureTarget = z.infer<typeof CaptureTarget>;

/** Keys a flow may press. Enter can submit a form, so a flow that presses it needs a confirm click. */
export const CAPTURE_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
] as const;
export const CaptureKey = z.enum(CAPTURE_KEYS);

/** A same-origin path: starts with one "/", never a scheme or a host. */
const RelativePath = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s\\]*$/, "must be a path on the demo site, like /dashboard");

/** Optional plain-English note about what this step shows ("Open the calendar view"). */
const note = z.string().max(MAX_TEXT).optional();

export const CaptureFlowStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), path: RelativePath, note }),
  z.object({ kind: z.literal("click"), target: CaptureTarget, note }),
  /** `text` is demo text only. Secrets and personal data are rejected at plan and save time. */
  z.object({ kind: z.literal("type"), field: CaptureTarget, text: z.string().min(1).max(500), note }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["down", "up"]),
    amountPx: z.number().int().min(50).max(5_000),
    note,
  }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(100).max(10_000), note }),
  z.object({ kind: z.literal("hover"), target: CaptureTarget, note }),
  z.object({ kind: z.literal("pressKey"), key: CaptureKey, note }),
]);
export type CaptureFlowStep = z.infer<typeof CaptureFlowStep>;

export const CaptureFlow = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(CaptureFlowStep).min(1).max(20),
  /** Log in first (separate, never-recorded context → storageState). */
  needsLogin: z.boolean(),
});
export type CaptureFlow = z.infer<typeof CaptureFlow>;

export const CaptureViewport = z.enum(["desktop", "mobile"]);
export type CaptureViewport = z.infer<typeof CaptureViewport>;
export const CAPTURE_VIEWPORTS: Record<CaptureViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/** One pointer event in a recording. x/y are 0..1 of the viewport; tMs is from the first video frame. */
export const ClickLogEntry = z.object({
  tMs: z.number().int().min(0),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  type: z.enum(["move", "click", "scroll"]),
});
export type ClickLogEntry = z.infer<typeof ClickLogEntry>;
export const ClickLog = z.array(ClickLogEntry);
export type ClickLog = z.infer<typeof ClickLog>;

// ── Model-facing variant (capture.flow_plan, Sonnet) ──
// Plain shape: every field required, nullable where it doesn't apply, no min/max keywords. The
// planner maps each step onto CaptureFlowStep and drops anything that doesn't parse or is denylisted.

export const CaptureTargetModel = z.object({
  by: z.enum(["text", "role", "label", "placeholder", "selector"]),
  text: z.string().nullable(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  label: z.string().nullable(),
  placeholder: z.string().nullable(),
  selector: z.string().nullable(),
});
export type CaptureTargetModel = z.infer<typeof CaptureTargetModel>;

export const CaptureStepModel = z.object({
  kind: z.enum(["goto", "click", "type", "scroll", "wait", "hover", "pressKey"]),
  path: z.string().nullable(),
  target: CaptureTargetModel.nullable(),
  text: z.string().nullable(),
  direction: z.enum(["down", "up"]).nullable(),
  amountPx: z.number().nullable(),
  ms: z.number().nullable(),
  key: z.string().nullable(),
  note: z.string(),
});
export type CaptureStepModel = z.infer<typeof CaptureStepModel>;

export const CaptureFlowPlanModel = z.object({
  flows: z.array(
    z.object({
      name: z.string(),
      /** Which product feature this shows, in one sentence. */
      shows: z.string(),
      needsLogin: z.boolean(),
      steps: z.array(CaptureStepModel),
    }),
  ),
});
export type CaptureFlowPlanModel = z.infer<typeof CaptureFlowPlanModel>;
