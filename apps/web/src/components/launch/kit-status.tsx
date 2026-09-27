import type { KitIssue } from "@mkt/contracts";
import { KIT_STATUS_LABEL, type KitStatusKey } from "./kit-model";

const TONE: Record<KitStatusKey, string> = {
  missing: "border-dashed border-zinc-700 text-zinc-500",
  planned: "border-sky-800 bg-sky-950/40 text-sky-300",
  generating: "border-sky-800 bg-sky-950/40 text-sky-300",
  ready: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  needs_you: "border-amber-700 bg-amber-950/40 text-amber-300",
  failed: "border-red-800 bg-red-950/40 text-red-300",
};

export function KitStatusChip({ status }: { status: KitStatusKey }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>{KIT_STATUS_LABEL[status]}</span>;
}

export function KitCostChip({ label }: { label: string }) {
  return <span className="inline-block rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">~{label}</span>;
}

/** Checks on a kit: "Fix first" blocks the download, "Worth a look" doesn't. */
export function KitIssues({ issues }: { issues: readonly KitIssue[] }) {
  if (!issues.length) return <p className="text-sm text-emerald-300">Every check passed.</p>;
  const blocks = issues.filter((i) => i.severity === "block");
  const warns = issues.filter((i) => i.severity === "warn");
  return (
    <div className="flex flex-col gap-3 text-sm">
      {blocks.length > 0 && (
        <div>
          <p className="font-medium text-red-300">Fix first ({blocks.length})</p>
          <ul className="mt-1 list-disc pl-5 text-zinc-300">
            {blocks.map((i, n) => (
              <li key={`b${n}`}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
      {warns.length > 0 && (
        <div>
          <p className="font-medium text-amber-300">Worth a look ({warns.length})</p>
          <ul className="mt-1 list-disc pl-5 text-zinc-400">
            {warns.map((i, n) => (
              <li key={`w${n}`}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Where each kind must say who made it or that it's paid (§8). Kinds without one are left out. */
export const DISCLOSURE_HINT: Partial<Record<string, string>> = {
  subreddit: "Each post says you made it.",
  ambassador: "#ad comes first in every caption and is said out loud in videos, plus TikTok's branded content steps.",
  creator: "#ad comes first in every caption and is said out loud in videos, plus TikTok's branded content steps.",
};

/** §8: the kit won't download without its disclosures. */
export function KitDisclosureStatus({ ok, kind }: { ok: boolean; kind: string }) {
  const hint = DISCLOSURE_HINT[kind];
  if (!hint) return null;
  return ok ? (
    <p className="text-sm text-emerald-300">Disclosures are in place. {hint}</p>
  ) : (
    <p className="text-sm text-red-300">A required disclosure is missing, so the kit can&apos;t be downloaded yet. {hint}</p>
  );
}
