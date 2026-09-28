import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/project-tabs";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceShell>
      <div className="px-4 pt-8 md:px-10">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Settings</p>
        <SettingsTabs />
      </div>
      {children}
    </WorkspaceShell>
  );
}
