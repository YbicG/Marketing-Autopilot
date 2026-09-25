"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CAPTURE_KEYS, CaptureFlow, type CaptureFlowStep, type CaptureTarget } from "@mkt/contracts";
import { postJson } from "@/lib/post-json";
import { field, primary, secondary } from "./setup-forms";

/** Serializable CaptureView flow (core/capture/setup.ts). */
export interface FlowRow {
  id: string;
  name: string;
  steps: CaptureFlowStep[];
  needsLogin: boolean;
  needsConfirm: boolean;
  confirmedAt: string | null;
  lastError: string | null;
  recording: {
    assetId: string;
    durationMs: number | null;
    piiHits: boolean;
    piiKinds: string[];
    piiBoxes: number;
    piiCheckError: string | null;
    blockedRequests: Record<string, number>;
    createdAt: string;
  } | null;
}

type Msg = { tone: "ok" | "err"; text: string } | null;
const Note = ({ msg }: { msg: Msg }) => (msg ? <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-400" : "text-amber-300"}`}>{msg.text}</p> : null);

const STEP_LABEL: Record<CaptureFlowStep["kind"], string> = {
  goto: "Open a page",
  click: "Click",
  type: "Type into",
  scroll: "Scroll",
  wait: "Wait",
  hover: "Point at",
  pressKey: "Press a key",
};

const TARGET_LABEL: Record<CaptureTarget["by"], string> = {
  text: "Text on it",
  role: "Kind and name",
  label: "Field label",
  placeholder: "Placeholder",
  selector: "CSS selector",
};

const PII_LABEL: Record<string, string> = {
  email: "email addresses",
  phone: "phone numbers",
  card: "card numbers",
  api_key: "keys or passwords",
  address: "street addresses",
  name: "names",
  face: "faces",
  other: "other personal details",
};

const secs = (ms: number | null) => (ms ? `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}` : "");

function targetText(t: CaptureTarget): string {
  switch (t.by) {
    case "text":
      return `“${t.text}”`;
    case "role":
      return `the ${t.role} “${t.name}”`;
    case "label":
      return `the field labelled “${t.label}”`;
    case "placeholder":
      return `the field showing “${t.placeholder}”`;
    case "selector":
      return t.selector;
  }
}

/** One step in plain words ("Click “Add course”"). */
export function stepText(s: CaptureFlowStep): string {
  const base = (() => {
    switch (s.kind) {
      case "goto":
        return `Open ${s.path}`;
      case "click":
        return `Click ${targetText(s.target)}`;
      case "type":
        return `Type “${s.text}” into ${targetText(s.field)}`;
      case "scroll":
        return `Scroll ${s.direction} ${s.amountPx}px`;
      case "wait":
        return `Wait ${(s.ms / 1000).toFixed(1)}s`;
      case "hover":
        return `Point at ${targetText(s.target)}`;
      case "pressKey":
        return `Press ${s.key}`;
    }
  })();
  return s.note ? `${base} (${s.note})` : base;
}

function blankTarget(by: CaptureTarget["by"]): CaptureTarget {
  switch (by) {
    case "text":
      return { by, text: "" };
    case "role":
      return { by, role: "button", name: "" };
    case "label":
      return { by, label: "" };
    case "placeholder":
      return { by, placeholder: "" };
    case "selector":
      return { by, selector: "" };
  }
}

function blankStep(kind: CaptureFlowStep["kind"]): CaptureFlowStep {
  switch (kind) {
    case "goto":
      return { kind, path: "/" };
    case "click":
      return { kind, target: blankTarget("text") };
    case "type":
      return { kind, field: blankTarget("label"), text: "" };
    case "scroll":
      return { kind, direction: "down", amountPx: 600 };
    case "wait":
      return { kind, ms: 1000 };
    case "hover":
      return { kind, target: blankTarget("text") };
    case "pressKey":
      return { kind, key: "Tab" };
  }
}

function TargetInput({ value, onChange }: { value: CaptureTarget; onChange: (t: CaptureTarget) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <select value={value.by} onChange={(e) => onChange(blankTarget(e.target.value as CaptureTarget["by"]))} className={`${field} w-36`} aria-label="Find it by">
        {(Object.keys(TARGET_LABEL) as CaptureTarget["by"][]).map((b) => (
          <option key={b} value={b}>
            {TARGET_LABEL[b]}
          </option>
        ))}
      </select>
      {value.by === "role" ? (
        <>
          <select value={value.role} onChange={(e) => onChange({ ...value, role: e.target.value })} className={`${field} w-28`} aria-label="Kind">
            {["button", "link", "tab", "menuitem", "checkbox", "option", "textbox"].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Name shown on it" className={`${field} min-w-40 flex-1`} />
        </>
      ) : (
        <input
          value={value.by === "text" ? value.text : value.by === "label" ? value.label : value.by === "placeholder" ? value.placeholder : value.selector}
          onChange={(e) => {
            const v = e.target.value;
            onChange(value.by === "text" ? { by: "text", text: v } : value.by === "label" ? { by: "label", label: v } : value.by === "placeholder" ? { by: "placeholder", placeholder: v } : { by: "selector", selector: v });
          }}
          spellCheck={value.by !== "selector"}
          className={`${field} min-w-40 flex-1 ${value.by === "selector" ? "font-mono text-xs" : ""}`}
          aria-label={TARGET_LABEL[value.by]}
        />
      )}
    </div>
  );
}

function StepInput({ step, onChange }: { step: CaptureFlowStep; onChange: (s: CaptureFlowStep) => void }) {
  switch (step.kind) {
    case "goto":
      return <input value={step.path} onChange={(e) => onChange({ ...step, path: e.target.value })} placeholder="/dashboard" spellCheck={false} className={field} aria-label="Page path" />;
    case "click":
    case "hover":
      return <TargetInput value={step.target} onChange={(target) => onChange({ ...step, target })} />;
    case "type":
      return (
        <div className="flex flex-col gap-2">
          <TargetInput value={step.field} onChange={(f) => onChange({ ...step, field: f })} />
          <input value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} placeholder="Sample text to type (never real personal details)" className={field} aria-label="Text to type" />
        </div>
      );
    case "scroll":
      return (
        <div className="flex gap-2">
          <select value={step.direction} onChange={(e) => onChange({ ...step, direction: e.target.value as "down" | "up" })} className={`${field} w-24`} aria-label="Direction">
            <option value="down">Down</option>
            <option value="up">Up</option>
          </select>
          <input type="number" min={50} max={5000} step={50} value={step.amountPx} onChange={(e) => onChange({ ...step, amountPx: Math.round(Number(e.target.value)) })} className={`${field} w-28`} aria-label="Pixels" />
        </div>
      );
    case "wait":
      return (
        <input type="number" min={0.1} max={10} step={0.1} value={step.ms / 1000} onChange={(e) => onChange({ ...step, ms: Math.round(Number(e.target.value) * 1000) })} className={`${field} w-28`} aria-label="Seconds" />
      );
    case "pressKey":
      return (
        <select value={step.key} onChange={(e) => onChange({ ...step, key: e.target.value as (typeof CAPTURE_KEYS)[number] })} className={`${field} w-36`} aria-label="Key">
          {CAPTURE_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      );
  }
}

/** Step-by-step editor for a new or existing flow. Saves through the server, which screens every step. */
export function FlowEditor({ slug, flow, onDone }: { slug: string; flow: FlowRow | null; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(flow?.name ?? "");
  const [needsLogin, setNeedsLogin] = useState(flow?.needsLogin ?? false);
  const [steps, setSteps] = useState<CaptureFlowStep[]>(flow?.steps ?? [blankStep("goto")]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const set = (i: number, s: CaptureFlowStep) => setSteps((xs) => xs.map((x, k) => (k === i ? s : x)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const next = [...xs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  async function save() {
    const parsed = CaptureFlow.safeParse({ name: name.trim(), steps, needsLogin });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue?.path[0] === "steps" && typeof issue.path[1] === "number" ? `Step ${issue.path[1] + 1}: ` : issue?.path[0] === "name" ? "Name: " : "";
      return setMsg({ tone: "err", text: `${at}${issue?.path[0] === "name" ? "give the flow a name." : "fill in every box, and start page paths with /."}` });
    }
    setBusy(true);
    setMsg(null);
    const base = `/api/capture/${encodeURIComponent(slug)}/flows`;
    const out = await postJson(flow ? `${base}/${flow.id}` : base, { flow: parsed.data });
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    router.refresh();
    onDone();
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-zinc-700 p-3">
      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Turn a syllabus into a calendar" className={field} disabled={busy} />
      </label>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={needsLogin} onChange={(e) => setNeedsLogin(e.target.checked)} disabled={busy} />
        Sign in with the demo login first
      </label>
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={i} className="flex flex-col gap-2 rounded border border-zinc-800 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs text-zinc-500">
                {i + 1}.
                <select value={s.kind} onChange={(e) => set(i, blankStep(e.target.value as CaptureFlowStep["kind"]))} className={`${field} w-40`} aria-label={`Step ${i + 1} action`} disabled={busy}>
                  {(Object.keys(STEP_LABEL) as CaptureFlowStep["kind"][]).map((k) => (
                    <option key={k} value={k}>
                      {STEP_LABEL[k]}
                    </option>
                  ))}
                </select>
              </span>
              <span className="flex gap-2 text-xs text-zinc-400">
                <button type="button" onClick={() => move(i, -1)} disabled={busy || i === 0} className="disabled:opacity-40" aria-label={`Move step ${i + 1} up`}>
                  ↑
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={busy || i === steps.length - 1} className="disabled:opacity-40" aria-label={`Move step ${i + 1} down`}>
                  ↓
                </button>
                <button type="button" onClick={() => setSteps((xs) => xs.filter((_, k) => k !== i))} disabled={busy || steps.length <= 1} className="hover:text-red-300 disabled:opacity-40">
                  Remove
                </button>
              </span>
            </div>
            <StepInput step={s} onChange={(next) => set(i, next)} />
            <input
              value={s.note ?? ""}
              onChange={(e) => {
                const note = e.target.value;
                const { note: _n, ...rest } = s;
                set(i, (note ? { ...rest, note } : rest) as CaptureFlowStep);
              }}
              placeholder="What this shows (optional)"
              className={`${field} text-xs`}
              aria-label={`Step ${i + 1} note`}
              disabled={busy}
            />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setSteps((xs) => [...xs, blankStep("click")])} disabled={busy || steps.length >= 20} className={secondary}>
          Add a step
        </button>
        <button type="button" onClick={() => void save()} disabled={busy} className={primary}>
          {busy ? "Saving…" : "Save flow"}
        </button>
        <button type="button" onClick={onDone} disabled={busy} className="text-sm text-zinc-400 underline underline-offset-2">
          Cancel
        </button>
      </div>
      <Note msg={msg} />
      <p className="text-xs text-zinc-500">Steps that sign in, type, press Enter or click a save-style button need you to confirm the flow before it's recorded.</p>
    </div>
  );
}

function blockerText(flow: FlowRow, origin: string | null): string | null {
  if (!origin) return "Add the demo site's internal address above first.";
  if (flow.needsLogin && !flow.confirmedAt && flow.needsConfirm) return "This flow signs in. Check the steps and confirm it before it's recorded.";
  if (flow.needsConfirm && !flow.confirmedAt) return "This flow fills in a form or presses a save-style button. Check the steps and confirm it before it's recorded.";
  return null;
}

function FlowCard({ slug, flow, origin, hasLogin }: { slug: string; flow: FlowRow; origin: string | null; hasLogin: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"confirm" | "record" | "delete" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const base = `/api/capture/${encodeURIComponent(slug)}/flows/${flow.id}`;
  const blocker = blockerText(flow, origin);
  const needsConfirm = flow.needsConfirm && !flow.confirmedAt;
  const loginMissing = flow.needsLogin && !hasLogin;
  const r = flow.recording;

  async function act(kind: "confirm" | "record") {
    setBusy(kind);
    setMsg(null);
    const out = await postJson(`${base}/${kind}`, {});
    setBusy(null);
    if (!out.ok) return setMsg({ tone: "err", text: out.error.replace(/ in Settings/g, " above") });
    setMsg({ tone: "ok", text: kind === "confirm" ? "Confirmed. You can record it now." : "Recording. It shows up here in a minute or two; refresh to check." });
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Delete “${flow.name}”? Footage already recorded stays in Assets.`)) return;
    setBusy("delete");
    setMsg(null);
    try {
      const res = await fetch(base, { method: "DELETE", headers: { "x-mkt-csrf": "1" } });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setBusy(null);
      if (!res.ok) return setMsg({ tone: "err", text: data.error ?? "That didn't work. Try again." });
      router.refresh();
    } catch {
      setBusy(null);
      setMsg({ tone: "err", text: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  if (editing) return <li><FlowEditor slug={slug} flow={flow} onDone={() => setEditing(false)} /></li>;

  const blockedTotal = r ? Object.values(r.blockedRequests).reduce((a, b) => a + b, 0) : 0;
  return (
    <li className="flex flex-col gap-3 rounded-md border border-zinc-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{flow.name}</h3>
        <span className="flex flex-wrap gap-2 text-xs">
          {flow.needsLogin && <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400">Signs in</span>}
          {flow.needsConfirm && (
            <span className={`rounded border px-1.5 py-0.5 ${flow.confirmedAt ? "border-emerald-800 text-emerald-300" : "border-amber-800 text-amber-300"}`}>
              {flow.confirmedAt ? "Confirmed" : "Needs your OK"}
            </span>
          )}
        </span>
      </div>
      <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-sm text-zinc-300">
        {flow.steps.map((s, i) => (
          <li key={i}>{stepText(s)}</li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        {needsConfirm && (
          <button type="button" onClick={() => void act("confirm")} disabled={busy !== null} className={primary}>
            {busy === "confirm" ? "Confirming…" : "I checked the steps: confirm"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void act("record")}
          disabled={busy !== null || !!blocker || loginMissing}
          title={blocker ?? (loginMissing ? "Save a demo login first" : undefined)}
          className={needsConfirm ? secondary : primary}
        >
          {busy === "record" ? "Starting…" : r ? "Refresh footage" : "Record"}
        </button>
        <button type="button" onClick={() => setEditing(true)} disabled={busy !== null} className={secondary}>
          Edit
        </button>
        <button type="button" onClick={() => void remove()} disabled={busy !== null} className="text-sm text-zinc-400 underline underline-offset-2 hover:text-red-300">
          {busy === "delete" ? "Deleting…" : "Delete"}
        </button>
      </div>
      {blocker && <p className="text-xs text-zinc-500">{blocker}</p>}
      {!blocker && loginMissing && <p className="text-xs text-zinc-500">This flow signs in: save a demo login above first.</p>}
      <Note msg={msg} />

      {flow.lastError && <p className="text-xs text-red-400">Last try didn't work: {flow.lastError}</p>}
      {r ? (
        <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-zinc-500">
            <span>
              Last recording{r.durationMs ? ` · ${secs(r.durationMs)}` : ""} · {new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
            <a href={`/api/media/${r.assetId}`} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              Open the file
            </a>
          </div>
          <video src={`/api/media/${r.assetId}`} controls preload="metadata" className="max-h-72 w-full rounded bg-black" />
          {r.piiHits ? (
            <p className="text-xs text-amber-300">
              It shows personal details{r.piiKinds.length ? ` (${r.piiKinds.map((k) => PII_LABEL[k] ?? k).join(", ")})` : ""}
              {r.piiBoxes ? `, ${r.piiBoxes} area${r.piiBoxes === 1 ? "" : "s"} flagged` : ""}, so it won't be used in videos. Use demo data with made-up names and record it again.
            </p>
          ) : (
            <p className="text-xs text-emerald-400">No personal details found.</p>
          )}
          {r.piiCheckError && <p className="text-xs text-amber-300">The personal details check didn't finish: {r.piiCheckError}</p>}
          {blockedTotal > 0 && (
            <p className="text-xs text-zinc-500">
              Stopped {blockedTotal} call{blockedTotal === 1 ? "" : "s"} the demo tried to make ({Object.entries(r.blockedRequests).map(([k, n]) => `${k}: ${n}`).join(", ")}).
            </p>
          )}
        </div>
      ) : (
        !flow.lastError && <p className="text-xs text-zinc-500">Not recorded yet.</p>
      )}
    </li>
  );
}

/** The flows list plus "Suggest flows" and "Add a flow". */
export function FlowList({ slug, flows, origin, hasLogin, suggestPrice }: { slug: string; flows: FlowRow[]; origin: string | null; hasLogin: boolean; suggestPrice: string }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function suggest() {
    setBusy(true);
    setMsg(null);
    const out = await postJson<{ flowIds: string[]; dropped: number }>(`/api/capture/${encodeURIComponent(slug)}/suggest`, {});
    setBusy(false);
    if (!out.ok) return setMsg({ tone: "err", text: out.error });
    const n = out.data.flowIds.length;
    setMsg({
      tone: n ? "ok" : "err",
      text: n
        ? `Added ${n} flow${n === 1 ? "" : "s"}. Check each one before recording.${out.data.dropped ? ` ${out.data.dropped} unsafe step${out.data.dropped === 1 ? " was" : "s were"} left out.` : ""}`
        : "No flows came back. Add one yourself below.",
    });
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Flows">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Flows to record</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void suggest()} disabled={busy} className={secondary}>
            {busy ? "Thinking…" : `Suggest flows · ~${suggestPrice}`}
          </button>
          <button type="button" onClick={() => setAdding(true)} disabled={adding} className={secondary}>
            Add a flow
          </button>
        </div>
      </div>
      <p className="text-sm text-zinc-400">
        A flow is a short list of steps the recorder follows on your demo site, like opening a page and clicking a button. Suggestions are planned from your site's pages and README;
        check the steps match your demo.
      </p>
      <Note msg={msg} />
      {adding && <FlowEditor slug={slug} flow={null} onDone={() => setAdding(false)} />}
      {flows.length === 0 && !adding ? (
        <p className="text-sm text-zinc-500">No flows yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {flows.map((f) => (
            <FlowCard key={f.id} slug={slug} flow={f} origin={origin} hasLogin={hasLogin} />
          ))}
        </ul>
      )}
    </section>
  );
}
