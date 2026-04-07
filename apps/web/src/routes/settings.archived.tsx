import { createFileRoute } from "@tanstack/react-router";

import { ArchivedWorkspacesPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedWorkspacesPanel,
});
