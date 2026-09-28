import type { ReactNode } from "react";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

export default function RunsLayout({ children }: { children: ReactNode }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
