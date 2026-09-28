import type { ReactNode } from "react";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <WorkspaceShell projectSlug={slug}>{children}</WorkspaceShell>;
}
