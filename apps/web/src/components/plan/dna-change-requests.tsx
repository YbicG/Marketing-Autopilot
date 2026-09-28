import { pendingDnaChanges } from "@mkt/core/tools";
import { getDb } from "@/lib/db";
import { DnaChangeButtons } from "./dna-change-buttons";

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
  return JSON.stringify(v, null, 2);
}

/**
 * Plan screen: profile changes an agent suggested (propose_dna_change, §9). Nothing changes until
 * the owner accepts one here; accepting is a UI-session action (D9), never a tool.
 */
export async function DnaChangeRequests({
  workspaceId,
  productId,
  slug,
  labelFor,
  valueAt,
}: {
  workspaceId: string;
  productId: string;
  slug: string;
  labelFor: (path: string) => string;
  valueAt: (path: string) => unknown;
}) {
  const reqs = await pendingDnaChanges(getDb(), workspaceId, productId);
  if (!reqs.length) return null;
  return (
    <section className="flex flex-col gap-3 rounded-md border border-sky-900/70 bg-sky-950/10 p-5" aria-label="Suggested changes">
      <div>
        <h2 className="text-lg font-semibold">Suggested by your agent</h2>
        <p className="text-sm text-zinc-400">Your profile stays as it is unless you accept a change.</p>
      </div>
      <ul className="flex flex-col gap-4">
        {reqs.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 border-t border-zinc-800 pt-3 first:border-0 first:pt-0">
            <p className="font-medium">{labelFor(r.path)}</p>
            {r.reason && <p className="text-sm text-zinc-300">{r.reason}</p>}
            <div className="grid gap-2 text-sm md:grid-cols-2">
              <div>
                <p className="text-xs text-zinc-500">Now</p>
                <pre className="whitespace-pre-wrap break-words font-sans text-zinc-400">{show(valueAt(r.path)) || "(empty)"}</pre>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Suggested</p>
                <pre className="whitespace-pre-wrap break-words font-sans text-zinc-200">{show(r.value)}</pre>
              </div>
            </div>
            <DnaChangeButtons slug={slug} id={r.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}
