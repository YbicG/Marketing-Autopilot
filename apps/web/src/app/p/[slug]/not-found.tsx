import { StatePage } from "@/components/shell/state-page";

/** A project slug that isn't in this workspace. Rendered inside the frame so the sidebar stays. */
export default function ProjectNotFound() {
  return <StatePage title="Project not found" body="There's no project at this address. It may have been renamed. Pick it from the sidebar or from Home." />;
}
