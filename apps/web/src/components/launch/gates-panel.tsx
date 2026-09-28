import type { LandingAuditView, LaunchGateSummary } from "@mkt/contracts";
import { LandingAudit } from "./gates-audit";
import { TrackingTest } from "./gates-tracking";

// Launch-day checks (§5.4, D20): the tracking test and the three landing gates. Each passes only
// when its check does; there is no tick box anywhere on this panel.

const TRACKING = "gate.tracking_test";

function GateLine({ g }: { g: LaunchGateSummary["gates"][number] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className={g.passed ? "text-emerald-400" : "text-rose"}>
          {g.passed ? "✓" : "✕"}
        </span>
        <span className="text-sm font-medium">{g.title}</span>
        <span className={`text-xs ${g.passed ? "text-emerald-400" : "text-rose"}`}>{g.passed ? "Passed" : "Not passed yet"}</span>
      </div>
      {!g.passed &&
        g.reasons.map((r) => (
          <p key={r} className="pl-6 text-xs text-zinc-400">
            {r}
          </p>
        ))}
    </div>
  );
}

export function GatesPanel({
  slug,
  gates,
  testUrl,
  audit,
  auditPrice,
  website,
}: {
  slug: string;
  gates: LaunchGateSummary;
  testUrl: string | null;
  audit: LandingAuditView | null;
  auditPrice: string;
  website: string | null;
}) {
  const tracking = gates.gates.find((g) => g.key === TRACKING);
  const landing = gates.gates.filter((g) => g.key !== TRACKING);
  return (
    <section id="checks" className="flex scroll-mt-4 flex-col gap-4 rounded-xl border border-zinc-800 p-5 bg-surface" aria-label="Launch-day checks">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Launch-day checks</h2>
          <p className="text-sm text-zinc-400">
            On launch day nothing posts until all of these pass. They pass on their own when the check passes; you can&apos;t tick them.
          </p>
        </div>
        <p className={`text-sm font-medium ${gates.allPassed ? "text-emerald-400" : "text-amber-300"}`} aria-live="polite">
          {gates.allPassed ? "All passed" : `${gates.gates.filter((g) => g.passed).length} of ${gates.gates.length} passed`}
        </p>
      </div>

      {tracking && (
        <div className="flex flex-col gap-2 border-t border-zinc-800 pt-4">
          <GateLine g={tracking} />
          <div className="pl-6">
            <TrackingTest slug={slug} testUrl={testUrl} passed={tracking.passed} />
          </div>
        </div>
      )}

      {landing.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-zinc-800 pt-4">
          {landing.map((g) => (
            <GateLine key={g.key} g={g} />
          ))}
          <div className="pl-6 pt-1">
            <LandingAudit key={`${audit?.id ?? "none"}-${audit?.status ?? ""}`} slug={slug} initial={audit} price={auditPrice} website={website} />
          </div>
        </div>
      )}
    </section>
  );
}
