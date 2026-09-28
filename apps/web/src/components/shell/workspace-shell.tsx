import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getWorkspace } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { AppShell } from "./app-shell";

/** Layout helper: the signed-in workspace's shell, optionally inside one project. */
export async function WorkspaceShell({ projectSlug, children }: { projectSlug?: string; children: ReactNode }) {
  const s = await requireWorkspace();
  const ws = await getWorkspace(getDb(), s.workspaceId);
  if (!ws) redirect("/signin");
  return (
    <AppShell workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} userName={s.name} projectSlug={projectSlug}>
      {children}
    </AppShell>
  );
}
