/**
 * SourceControlPanel — renders a git-style file tree sidebar.
 *
 * The actual diff rendering has moved to DiffFileTab, which opens in
 * the main tab content area when a file is clicked in the tree.
 */

import type { SourceControlPanelMode } from "./SourceControlPanelShell";
import { SourceControlSidebar } from "./SourceControlSidebar";

interface SourceControlPanelProps {
  mode?: SourceControlPanelMode;
}

export default function SourceControlPanel({ mode: _mode = "inline" }: SourceControlPanelProps) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <SourceControlSidebar />
    </div>
  );
}
