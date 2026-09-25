import Link from "next/link";
import { formatUsd, monthSpend, openAlerts } from "@mkt/core/cost";
import { getDb } from "@/lib/db";
import { BudgetToast } from "./budget-toast";

/** Header spend meter (§2.2): this month's settled + in-flight spend against the limit. */
export async function Header({ workspaceId, limitMicros }: { workspaceId: string; limitMicros: number }) {
  const [m, alerts] = await Promise.all([
    monthSpend(getDb(), workspaceId, limitMicros),
    openAlerts(getDb(), workspaceId),
  ]);
  const alert = alerts[0]; // highest threshold first
  const used = m.spentMicros + m.reservedMicros;
  const pct = m.capMicros > 0 ? Math.min(100, Math.round((used / m.capMicros) * 100)) : 0;
  const tone = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <header className="border-b border-zinc-800">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-semibold">
          Marketing Autopilot
        </Link>
        <Link href="/settings" className="flex items-center gap-3 text-sm text-zinc-400 hover:text-zinc-200">
          <span>
            {formatUsd(used)} / {formatUsd(m.capMicros)} this month · Subscriptions $0/mo
          </span>
          <span className="h-1.5 w-20 overflow-hidden rounded bg-zinc-800">
            <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
          </span>
        </Link>
      </div>
      {alert && <BudgetToast thresholdPct={alert.thresholdPct} limitLabel={wholeUsd(alert.capMicros)} />}
    </header>
  );
}

/** "$60" for whole dollars, otherwise "$60.50". */
function wholeUsd(micros: number): string {
  return formatUsd(micros).replace(/\.00$/, "");
}
