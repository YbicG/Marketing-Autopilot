import { USD, configuredPurposes, formatMonthlyRange, subscriptionSummary } from "@mkt/core/cost";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { LimitForm } from "./limit-form";

export const dynamic = "force-dynamic";

/** First run (§2.3): the one setting we ask for up front. */
export default async function WelcomePage() {
  const s = await requireWorkspace();
  const ws = await getWorkspace(getDb(), s.workspaceId);
  const current = Math.round((ws?.monthlyLimitMicros ?? 60 * USD) / USD);
  const subs = formatMonthlyRange(subscriptionSummary(await configuredPurposes(getDb(), s.workspaceId)));

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold">Monthly spending limit</h1>
        <p className="mt-2 text-sm text-zinc-400">
          The most the app may spend on AI in a calendar month. You'll get a heads-up at 50% and 80%, and everything
          stops at 100% until you raise it.
        </p>
      </div>
      <LimitForm initialUsd={current} next="/" />
      <p className="text-xs text-zinc-500">Subscriptions: {subs}. Services you connect later show up here.</p>
    </main>
  );
}
