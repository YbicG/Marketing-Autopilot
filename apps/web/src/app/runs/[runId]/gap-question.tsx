"use client";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

export type QuestionState = {
  id: string;
  question: string;
  options: string[];
  status: "open" | "answered" | "skipped";
  answer: string | null;
};

/** One in-feed question: pick an option, type an answer, or skip. Never blocks the run. */
export function GapQuestion({ runId, q }: { runId: string; q: QuestionState }) {
  const [state, setState] = useState(q);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(answer: string | null) {
    setBusy(true);
    setError(null);
    const out = await postJson(`/api/runs/${runId}/answers`, { questionId: state.id, answer });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setState((s) => ({ ...s, status: answer ? "answered" : "skipped", answer }));
  }

  if (state.status !== "open") {
    return (
      <div className="rounded-md border border-zinc-800 p-3 text-sm">
        <p className="text-zinc-400">{state.question}</p>
        <p className="mt-1 text-zinc-200">{state.status === "answered" ? state.answer : "Skipped"}</p>
      </div>
    );
  }

  const inputId = `answer-${state.id}`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-sky-900/70 bg-sky-950/20 p-3 text-sm">
      <p className="font-medium text-zinc-100">{state.question}</p>
      {state.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {state.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={busy}
              onClick={() => void send(o)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-60"
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send(text.trim());
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Your answer
        </label>
        <input
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2_000}
          placeholder="Or type your own answer"
          className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs outline-none focus:border-zinc-600"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 disabled:opacity-60"
        >
          Send
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void send(null)}
          className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-600 disabled:opacity-60"
        >
          Skip
        </button>
      </form>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
