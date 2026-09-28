import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/project-tabs";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceShell>
      <div className="px-4 pt-6 md:px-10">
        <SettingsTabs />
      </div>
      {children}
    </WorkspaceShell>
  );
}
