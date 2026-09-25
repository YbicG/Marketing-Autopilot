import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { callClaude, type ClaudeCall, type ClaudeDeps } from "./call.ts";
import { claudeFormat } from "./structured.ts";

/** A client tool: the zod schema both describes the input to Claude and validates it before `run`. */
export interface ClientTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>): Promise<string>;
}

export function clientTool<S extends z.ZodType>(t: ClientTool<S>): ClientTool<S> {
  return t;
}

/**
 * Streamed calls with client tools set eager_input_streaming (the server then skips its own
 * validation, so every input is re-validated here before a handler runs).
 */
export function toToolParam(t: ClientTool): Anthropic.Tool {
  const { schema } = claudeFormat(t.schema);
  return {
    name: t.name,
    description: t.description,
    input_schema: schema as Anthropic.Tool.InputSchema,
    eager_input_streaming: true,
  } as Anthropic.Tool;
}

export interface ToolLoopInput extends Omit<ClaudeCall, "tools" | "outputFormat"> {
  serverTools?: Anthropic.ToolUnion[];
  clientTools: ClientTool[];
  /** Paid model turns, including pause_turn resumes. */
  maxIterations?: number;
  maxPauseResumes?: number;
  onToolCall?: (name: string, input: unknown) => void;
}

export interface ToolLoopResult {
  messages: Anthropic.MessageParam[];
  final: Anthropic.Message;
  iterations: number;
  pauseResumes: number;
  toolCalls: number;
  stoppedEarly: boolean;
  callIds: string[];
}

/**
 * Manual agentic loop (§5.0 "Client tools"). Every turn is its own runPaidCall via callClaude, so a
 * budget stop lands between turns. refusal / max_tokens are checked (in callClaude) before any tool runs.
 * pause_turn: re-send the conversation with the paused assistant turn and no extra user message.
 */
export async function runToolLoop(deps: ClaudeDeps, input: ToolLoopInput): Promise<ToolLoopResult> {
  const { serverTools = [], clientTools, maxIterations = 12, maxPauseResumes = 4, onToolCall, ...call } = input;
  const byName = new Map(clientTools.map((t) => [t.name, t]));
  const tools = [...serverTools, ...clientTools.map(toToolParam)];
  const messages: Anthropic.MessageParam[] = [...call.messages];
  const callIds: string[] = [];
  let pauseResumes = 0;
  let toolCalls = 0;

  for (let i = 1; ; i++) {
    const { message, callIds: ids } = await callClaude(deps, { ...call, messages, tools });
    callIds.push(...ids);
    messages.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });

    const done = (stoppedEarly: boolean): ToolLoopResult => ({
      messages,
      final: message,
      iterations: i,
      pauseResumes,
      toolCalls,
      stoppedEarly,
      callIds,
    });

    if (message.stop_reason === "pause_turn") {
      if (pauseResumes >= maxPauseResumes || i >= maxIterations) return done(true);
      pauseResumes++;
      continue;
    }

    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || uses.length === 0) return done(false);

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      toolCalls++;
      results.push(await runOne(byName.get(use.name), use, onToolCall));
    }
    messages.push({ role: "user", content: results });
    if (i >= maxIterations) return done(true);
  }
}

async function runOne(
  tool: ClientTool | undefined,
  use: Anthropic.ToolUseBlock,
  onToolCall?: (name: string, input: unknown) => void,
): Promise<Anthropic.ToolResultBlockParam> {
  const error = (content: string): Anthropic.ToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: use.id,
    is_error: true,
    content,
  });
  if (!tool) return error(`Unknown tool ${use.name}`);
  const parsed = tool.schema.safeParse(use.input);
  if (!parsed.success) {
    return error(
      JSON.stringify({
        INVALID_INPUT: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        received: use.input,
      }).slice(0, 4_000),
    );
  }
  onToolCall?.(use.name, parsed.data);
  try {
    return { type: "tool_result", tool_use_id: use.id, content: await tool.run(parsed.data) };
  } catch (err) {
    return error(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
