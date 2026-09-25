import Anthropic from "@anthropic-ai/sdk";
import { secret } from "../config/index.ts";

let client: Anthropic | undefined;

/**
 * One SDK client for the process. The SDK's own timeout and retries are used as-is:
 * never pass `timedFetch` here, because its deadline would kill long thinking calls (§5.0).
 */
export function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: secret("ANTHROPIC_API_KEY"), maxRetries: 2, timeout: 600_000 });
  return client;
}
