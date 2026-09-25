// Test doubles for the Anthropic client (used by core's own tests only; not a package export).
import { EventEmitter } from "node:events";
import type Anthropic from "@anthropic-ai/sdk";

export class FakeStream extends EventEmitter {
  aborted = false;
  constructor(
    private readonly msg: Partial<Anthropic.Message> | null,
    private readonly delayMs = 0,
  ) {
    super();
  }
  abort() {
    this.aborted = true;
    this.emit("abort");
  }
  finalMessage(): Promise<Anthropic.Message> {
    return new Promise((resolve, reject) => {
      if (!this.msg) {
        this.once("abort", () => reject(new Error("Request was aborted.")));
        return;
      }
      setTimeout(() => {
        this.emit("streamEvent");
        resolve(this.msg as Anthropic.Message);
      }, this.delayMs);
    });
  }
}

export type FakeReply = Partial<Anthropic.Message> | ((params: Record<string, unknown>) => Partial<Anthropic.Message>);

/** Replies are consumed in order; a function reply can look at the request. */
export function fakeClient(replies: FakeReply[]) {
  const calls: Record<string, unknown>[] = [];
  const next = (params: Record<string, unknown>) => {
    calls.push(structuredClone(params));
    const r = replies.shift();
    if (!r) throw new Error("no more fake replies");
    const msg = typeof r === "function" ? r(params) : r;
    return new FakeStream({
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: String(params.model),
      stop_reason: "end_turn",
      usage: fakeUsage(100, 50),
      content: [],
      ...msg,
    } as Partial<Anthropic.Message>);
  };
  const client = { messages: { stream: next }, beta: { messages: { stream: next } } } as unknown as Anthropic;
  return { client, calls };
}

export const fakeUsage = (input: number, output: number) =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }) as Anthropic.Usage;

export const text = (t: string): Anthropic.TextBlock => ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;

export const toolUse = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;

/** A reply whose text is the JSON of `value` (structured output). */
export const jsonReply = (value: unknown): Partial<Anthropic.Message> => ({ content: [text(JSON.stringify(value))] });
