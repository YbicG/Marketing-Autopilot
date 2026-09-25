import { redirect } from "next/navigation";
import { USD } from "@mkt/core/cost";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../header";
import { LimitForm } from "../welcome/limit-form";
import { DeleteWorkspace } from "./delete-workspace";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await requireWorkspace();
  const ws = await getWorkspace(getDb(), s.workspaceId);
  if (!ws) redirect("/signin");

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <main className="mx-auto flex max-w-md flex-col gap-10 px-4 py-10">
        <section className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold">Monthly spending limit</h1>
          <LimitForm initialUsd={Math.round(ws.monthlyLimitMicros / USD)} next="/settings" />
        </section>
        <section className="flex flex-col gap-3 rounded-md border border-red-900/60 p-4">
          <h2 className="font-medium text-red-300">Delete everything</h2>
          <p className="text-sm text-zinc-400">
            Removes all runs, spending history and settings for this workspace, and signs you out. This can't be undone.
          </p>
          <DeleteWorkspace />
        </section>
      </main>
    </>
  );
}
