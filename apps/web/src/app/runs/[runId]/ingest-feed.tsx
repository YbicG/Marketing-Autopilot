"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RunEvent } from "@mkt/contracts";
import { SourceLink } from "@/components/source-link";
import { postJson } from "@/lib/post-json";
import { GapQuestion, type QuestionState } from "./gap-question";

type StepState = "waiting" | "working" | "done" | "warning" | "skipped" | "failed";
type Step = { id: string; label: string; state: StepState; note: string | null };
type FeedItem = { key: number; kind: "fact" | "competitor" | "quote"; text: string; url: string | null };
type Failure = { message: string; retryable: boolean };

const STATE_LABEL: Record<StepState, string> = {
  waiting: "Waiting",
  working: "Working…",
  done: "Done",
  warning: "Partly done",
  skipped: "Skipped",
  failed: "Failed",
};
const STATE_DOT: Record<StepState, string> = {
  waiting: "bg-zinc-700",
  working: "bg-sky-400 animate-pulse",
  done: "bg-emerald-500",
  warning: "bg-amber-500",
  skipped: "bg-zinc-600",
  failed: "bg-red-500",
};

type Props = {
  runId: string;
  kind: string;
  stages: readonly { id: string; label: string }[];
  initialStatus: string;
  initialQuestions: QuestionState[];
  planHref: string | null;
};

/** "Reading your product" (§2.3): steps with states, a facts feed, a screenshot strip and questions. */
export function IngestFeed({ runId, kind, stages, initialStatus, initialQuestions, planHref }: Props) {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(() => stages.map((s) => ({ ...s, state: "waiting", note: null })));
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [shots, setShots] = useState<{ id: string; caption: string | null }[]>([]);
  const [questions, setQuestions] = useState<QuestionState[]>(initialQuestions);
  const [spent, setSpent] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`);
    let n = 0;
    const update = (id: string, patch: (s: Step) => Partial<Step>) =>
      setSteps((prev) => {
        const known = prev.some((s) => s.id === id);
        const base = known ? prev : [...prev, { id, label: id, state: "waiting" as const, note: null }];
        return base.map((s) => (s.id === id ? { ...s, ...patch(s) } : s));
      });
    const push = (item: Omit<FeedItem, "key">) => setFeed((prev) => [...prev, { ...item, key: n++ }].slice(-200));
    const goToPlan = () => {
      es.close();
      if (planHref) router.push(planHref);
      else router.refresh();
    };

    es.onmessage = (msg) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }
      switch (ev.type) {
        case "stage_started":
          update(ev.stage, () => ({ state: "working", label: ev.label, note: null }));
          break;
        case "stage_progress":
          update(ev.stage, () => ({ note: ev.message }));
          break;
        case "stage_done":
          update(ev.stage, (s) => ({ state: s.state === "warning" ? "warning" : "done" }));
          break;
        case "stage_warning":
          update(ev.stage, () => ({ state: "warning", note: ev.message }));
          break;
        case "stage_skipped":
          update(ev.stage, () => ({ state: "skipped", note: ev.reason }));
          break;
        case "fact_found":
          push({ kind: "fact", text: ev.text, url: null });
          break;
        case "competitor_found":
          push({ kind: "competitor", text: ev.name, url: ev.url });
          break;
        case "quote_found":
          push({ kind: "quote", text: ev.text, url: ev.url });
          break;
        case "asset_found": {
          const { assetId, caption } = ev;
          setShots((prev) =>
            prev.some((a) => a.id === assetId)
              ? prev.map((a) => (a.id === assetId ? { ...a, caption: caption ?? a.caption } : a))
              : [...prev, { id: assetId, caption }],
          );
          break;
        }
        case "question_ready": {
          const q: QuestionState = { id: ev.questionId, question: ev.question, options: ev.options, status: "open", answer: null };
          setQuestions((prev) => (prev.some((x) => x.id === q.id) ? prev : [...prev, q]));
          break;
        }
        case "cost_update":
          setSpent(ev.spentMicros);
          break;
        case "artifact_ready":
          if (ev.kind === "strategy_run") goToPlan();
          break;
        case "stage_failed": {
          const { stage, message, retryable } = ev;
          setSteps((prev) => {
            const hit = prev.some((s) => s.id === stage);
            return prev.map((s) =>
              (hit ? s.id === stage : s.state === "working") ? { ...s, state: "failed", note: message } : s,
            );
          });
          setFailure({ message, retryable });
          es.close();
          break;
        }
        case "run_completed":
          goToPlan();
          break;
      }
    };
    return () => es.close();
  }, [runId, router, planHref]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    const out = await postJson<{ runId?: string }>(`/api/runs/${runId}/retry`, {});
    if (!out.ok || !out.data.runId) {
      setRetryError(out.ok ? "Couldn't start again. Try in a minute." : out.error);
      setRetrying(false);
      return;
    }
    router.push(`/runs/${out.data.runId}`);
  }

  const openQuestions = questions.some((q) => q.status === "open");

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-2 rounded-md border border-zinc-800 p-4" aria-label="Steps">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3 text-sm">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATE_DOT[s.state]}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className={s.state === "waiting" ? "text-zinc-500" : "text-zinc-100"}>{s.label}</span>
                <span className="shrink-0 text-xs text-zinc-500">{STATE_LABEL[s.state]}</span>
              </div>
              {s.note && (
                <p className={`text-xs ${s.state === "failed" ? "text-red-400" : s.state === "warning" ? "text-amber-300" : "text-zinc-500"}`}>
                  {s.note}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {failure && (
        <div role="alert" className="flex flex-col gap-3 rounded-md border border-red-900/70 p-4 text-sm">
          <p className="text-red-300">{failure.message}</p>
          {failure.retryable && kind === "ingest" && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void retry()}
                disabled={retrying}
                className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
              >
                {retrying ? "Starting…" : "Try again"}
              </button>
              <span className="text-xs text-zinc-500">Same links, folder and notes.</span>
            </div>
          )}
          {retryError && <p className="text-xs text-red-400">{retryError}</p>}
        </div>
      )}

      {questions.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Questions">
          <h2 className="text-sm font-medium text-zinc-300">A few questions</h2>
          {openQuestions && <p className="text-xs text-zinc-500">Optional. The run won't wait long for these.</p>}
          {questions.map((q) => (
            <GapQuestion key={q.id} runId={runId} q={q} />
          ))}
        </section>
      )}

      {shots.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Screenshots">
          <h2 className="text-sm font-medium text-zinc-300">Screenshots</h2>
          <ul className="flex gap-3 overflow-x-auto pb-2">
            {shots.map((a) => (
              <li key={a.id} className="w-48 shrink-0">
                <img
                  src={`/api/media/${a.id}?v=preview`}
                  alt={a.caption ?? "Screenshot of your product"}
                  loading="lazy"
                  className="h-28 w-48 rounded border border-zinc-800 bg-zinc-900 object-cover object-top"
                />
                {a.caption && <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{a.caption}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2" aria-label="What we found">
        <h2 className="text-sm font-medium text-zinc-300">What we found</h2>
        {feed.length === 0 && !failure && (
          <p className="text-sm text-zinc-500">{initialStatus === "queued" ? "Waiting for the worker…" : "Reading…"}</p>
        )}
        <ul className="flex flex-col gap-1.5 text-sm">
          {feed.map((f) => (
            <li key={f.key} className="flex flex-wrap items-baseline gap-x-2 text-zinc-300">
              {f.kind === "competitor" && <span className="text-xs text-zinc-500">Similar product:</span>}
              {f.kind === "quote" && <span className="text-xs text-zinc-500">People say:</span>}
              <span className={f.kind === "quote" ? "italic text-zinc-400" : ""}>{f.text}</span>
              <SourceLink url={f.url} />
            </li>
          ))}
        </ul>
      </section>

      {spent !== null && <p className="text-xs text-zinc-500">Spent so far ${(spent / 1_000_000).toFixed(2)}</p>}
    </div>
  );
}
