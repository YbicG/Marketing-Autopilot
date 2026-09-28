import type { UiSession } from "../publishing/approvals.ts";
import { canonicalJson, sha256Hex } from "../engine/hash.ts";
import { mintConfirmToken, verifyConfirmToken, type ConfirmResult } from "../security/confirm-token.ts";

/**
 * Confirm tokens for agent spend over the token's limits (D10, §9 spend phase 2). The HMAC covers
 * the tool, a hash of the workspace + token + validated input, and the estimate; it lasts 10 minutes.
 * Only the UI mints one (it takes a UiSession), after CJ saw the tool, the input and the price.
 */

export const toolPurpose = (tool: string) => `tool:${tool}`;

export function toolSubjectHash(workspaceId: string, patId: string, input: unknown): string {
  return sha256Hex(canonicalJson({ workspaceId, patId, input }));
}

export function mintToolConfirmToken(
  session: UiSession,
  claim: { tool: string; patId: string; input: unknown; estimateMicros: number },
  secret: string,
  now = Date.now(),
): string {
  return mintConfirmToken(
    { purpose: toolPurpose(claim.tool), subjectHash: toolSubjectHash(session.workspaceId, claim.patId, claim.input), estimateMicros: claim.estimateMicros },
    secret,
    undefined,
    now,
  );
}

export function verifyToolConfirmToken(
  token: string,
  expected: { workspaceId: string; patId: string; tool: string; input: unknown; estimateMicros: number },
  secret: string,
  now = Date.now(),
): ConfirmResult {
  return verifyConfirmToken(
    token,
    {
      purpose: toolPurpose(expected.tool),
      subjectHash: toolSubjectHash(expected.workspaceId, expected.patId, expected.input),
      estimateMicros: expected.estimateMicros,
    },
    secret,
    now,
  );
}

/** The confirm page's link: the tool, the token and the input, in the URL (no personal data, ≤2 KB). */
export const CONFIRM_INPUT_MAX = 2_048;

export function confirmUrl(baseUrl: string, tool: string, patId: string, input: unknown): string {
  const i = Buffer.from(canonicalJson(input), "utf8").toString("base64url");
  const u = new URL("/confirm", baseUrl);
  u.searchParams.set("tool", tool);
  u.searchParams.set("pat", patId);
  u.searchParams.set("input", i);
  return u.toString();
}

export function decodeConfirmInput(raw: string | null | undefined): unknown {
  if (!raw || raw.length > CONFIRM_INPUT_MAX * 2) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
