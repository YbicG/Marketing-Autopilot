/** D15: a refusal is surfaced as "Needs you". The model is never switched silently. */
export class ClaudeRefused extends Error {
  readonly code = "blocked_by_policy";
  constructor(readonly stopDetails: unknown) {
    super("Claude declined this request");
    this.name = "ClaudeRefused";
  }
}

export class ClaudeTruncated extends Error {
  readonly code = "max_tokens";
  constructor(readonly maxTokens: number) {
    super(`Output hit max_tokens (${maxTokens})`);
    this.name = "ClaudeTruncated";
  }
}

export interface StopInfo {
  stop_reason: string | null;
  stop_details?: unknown;
}

/** Check the stop reason before anything reads `content` or runs a tool. */
export function assertUsableStop(msg: StopInfo, maxTokens: number): void {
  if (msg.stop_reason === "refusal") throw new ClaudeRefused(msg.stop_details ?? null);
  if (msg.stop_reason === "max_tokens") throw new ClaudeTruncated(maxTokens);
}
