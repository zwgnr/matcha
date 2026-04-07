import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import WorkspaceSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";

const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_workspace_sidebar_width";
const WORKSPACE_SIDEBAR_MIN_WIDTH = 13 * 16;
const WORKSPACE_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-sidebar-border"
        resizable={{
          minWidth: WORKSPACE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= WORKSPACE_MAIN_CONTENT_MIN_WIDTH,
          storageKey: WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <WorkspaceSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  );
}
