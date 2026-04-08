import { WorkspaceId } from "@matcha/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect, useState } from "react";

import ChatView from "../components/ChatView";
import {
  SourceControlPanelLoadingState,
  type SourceControlPanelMode,
} from "../components/SourceControlPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type SourceControlRouteSearch,
  parseSourceControlRouteSearch,
  stripSourceControlSearchParams,
} from "../sourceControlRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const SourceControlPanel = lazy(() => import("../components/SourceControlPanel"));
const SC_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const SC_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const SC_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const SC_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

const SourceControlSheet = (props: {
  children: ReactNode;
  sourceControlOpen: boolean;
  onCloseSourceControl: () => void;
}) => {
  return (
    <Sheet
      open={props.sourceControlOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseSourceControl();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const SourceControlLoadingFallback = () => {
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <SourceControlPanelLoadingState label="Loading changes..." />
    </div>
  );
};

const LazySourceControlPanel = (props: { mode: SourceControlPanelMode }) => {
  return (
    <Suspense fallback={<SourceControlLoadingFallback />}>
      <SourceControlPanel mode={props.mode} />
    </Suspense>
  );
};

const SourceControlInlineSidebar = (props: {
  sourceControlOpen: boolean;
  onCloseSourceControl: () => void;
  onOpenSourceControl: () => void;
  renderSourceControlContent: boolean;
}) => {
  const {
    sourceControlOpen,
    onCloseSourceControl,
    onOpenSourceControl,
    renderSourceControlContent,
  } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenSourceControl();
        return;
      }
      onCloseSourceControl();
    },
    [onCloseSourceControl, onOpenSourceControl],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={sourceControlOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": SC_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: SC_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: SC_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderSourceControlContent ? <LazySourceControlPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function ChatWorkspaceRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const workspaceId = Route.useParams({
    select: (params) => WorkspaceId.makeUnsafe(params.workspaceId),
  });
  const search = Route.useSearch();
  const workspaceExists = useStore((store) =>
    store.workspaces.some((workspace) => workspace.id === workspaceId),
  );
  const draftWorkspaceExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftWorkspacesByWorkspaceId, workspaceId),
  );
  const routeWorkspaceExists = workspaceExists || draftWorkspaceExists;
  const sourceControlOpen = search.diff === "1";
  const shouldUseSourceControlSheet = useMediaQuery(SC_INLINE_LAYOUT_MEDIA_QUERY);
  // TanStack Router keeps active route components mounted across param-only navigations
  // unless remountDeps are configured, so this stays warm across workspace switches.
  const [hasOpenedSourceControl, setHasOpenedDiff] = useState(sourceControlOpen);
  const closeSourceControl = useCallback(() => {
    void navigate({
      to: "/$workspaceId",
      params: { workspaceId },
      search: { diff: undefined },
    });
  }, [navigate, workspaceId]);
  const openSourceControl = useCallback(() => {
    void navigate({
      to: "/$workspaceId",
      params: { workspaceId },
      search: (previous) => {
        const rest = stripSourceControlSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, workspaceId]);

  useEffect(() => {
    if (sourceControlOpen) {
      setHasOpenedDiff(true);
    }
  }, [sourceControlOpen]);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (!routeWorkspaceExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [bootstrapComplete, navigate, routeWorkspaceExists, workspaceId]);

  if (!bootstrapComplete || !routeWorkspaceExists) {
    return null;
  }

  const shouldRenderSourceControlContent = sourceControlOpen || hasOpenedSourceControl;

  if (!shouldUseSourceControlSheet) {
    return (
      <>
        <SidebarInset className="h-dvh  min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView workspaceId={workspaceId} />
        </SidebarInset>
        <SourceControlInlineSidebar
          sourceControlOpen={sourceControlOpen}
          onCloseSourceControl={closeSourceControl}
          onOpenSourceControl={openSourceControl}
          renderSourceControlContent={shouldRenderSourceControlContent}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView workspaceId={workspaceId} />
      </SidebarInset>
      <SourceControlSheet
        sourceControlOpen={sourceControlOpen}
        onCloseSourceControl={closeSourceControl}
      >
        {shouldRenderSourceControlContent ? <LazySourceControlPanel mode="sheet" /> : null}
      </SourceControlSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$workspaceId")({
  validateSearch: (search) => parseSourceControlRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<SourceControlRouteSearch>(["diff"])],
  },
  component: ChatWorkspaceRouteView,
});
