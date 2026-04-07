import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { useHandleNewWorkspace } from "../hooks/useHandleNewWorkspace";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { useWorkspaceSelectionStore } from "../workspaceSelectionStore";
import { useWorkspaceTabStore } from "../workspaceTabStore";
import { resolveSidebarNewWorkspaceEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useWorkspaceSelectionStore((state) => state.clearSelection);
  const selectedWorkspaceIdsSize = useWorkspaceSelectionStore(
    (state) => state.selectedWorkspaceIds.size,
  );
  const {
    activeDraftWorkspace,
    activeWorkspace,
    defaultProjectId,
    handleNewWorkspace,
    routeWorkspaceId,
  } = useHandleNewWorkspace();
  const keybindings = useServerKeybindings();
  const terminalOpen = useWorkspaceTabStore((state) => {
    if (!routeWorkspaceId) return false;
    const tabState = state.tabStateByWorkspaceWorkspaceId[routeWorkspaceId];
    if (!tabState) return false;
    const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
    return activeTab?.kind === "terminal";
  });
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape" && selectedWorkspaceIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const projectId =
        activeWorkspace?.projectId ?? activeDraftWorkspace?.projectId ?? defaultProjectId;
      if (!projectId) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewWorkspace(projectId, {
          envMode: resolveSidebarNewWorkspaceEnvMode({
            defaultEnvMode: appSettings.defaultWorkspaceEnvMode,
          }),
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewWorkspace(projectId, {
          branch: activeWorkspace?.branch ?? activeDraftWorkspace?.branch ?? null,
          worktreePath: activeWorkspace?.worktreePath ?? activeDraftWorkspace?.worktreePath ?? null,
          envMode:
            activeDraftWorkspace?.envMode ?? (activeWorkspace?.worktreePath ? "worktree" : "local"),
        });
        return;
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftWorkspace,
    activeWorkspace,
    clearSelection,
    handleNewWorkspace,
    keybindings,
    defaultProjectId,
    selectedWorkspaceIdsSize,
    terminalOpen,
    appSettings.defaultWorkspaceEnvMode,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
