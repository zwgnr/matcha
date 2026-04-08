import { type ProviderKind } from "@matcha/contracts";
import { DragDropProvider } from "@dnd-kit/react";
import { PointerSensor, PointerActivationConstraints } from "@dnd-kit/dom";
import { useSortable } from "@dnd-kit/react/sortable";
import { FileDiffIcon, PlusIcon, TerminalSquareIcon, XIcon } from "lucide-react";
import { memo, useCallback } from "react";
import type { TabKind, WorkspaceTab } from "../../workspaceTabStore";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";

const TAB_ICON_BY_PROVIDER: Record<ProviderKind, React.ComponentType<{ className?: string }>> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
};

function TabIcon({ tab }: { tab: WorkspaceTab }) {
  if (tab.kind === "terminal") {
    return <TerminalSquareIcon className="size-3.5" />;
  }
  if (tab.kind === "diff") {
    return <FileDiffIcon className="size-3.5" />;
  }
  const IconComponent = tab.provider ? TAB_ICON_BY_PROVIDER[tab.provider] : null;
  return IconComponent ? <IconComponent className="size-3.5" /> : null;
}

function SortableTab({
  tab,
  index,
  isActive,
  closable,
  onSelectTab,
  onCloseTab,
}: {
  tab: WorkspaceTab;
  index: number;
  isActive: boolean;
  closable: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}) {
  const { ref, isDragging } = useSortable({
    id: tab.id,
    index,
    type: "tab",
  });

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelectTab(tab.id)}
      className={cn(
        "group relative flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
        isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground/80",
        isDragging ? "z-20 opacity-70" : "",
      )}
    >
      {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground" />}
      <TabIcon tab={tab} />
      <span className="whitespace-nowrap">{tab.label}</span>
      {closable && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={`Close ${tab.label} tab`}
          className="ml-0.5 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onCloseTab(tab.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              onCloseTab(tab.id);
            }
          }}
        >
          <XIcon className="size-3" />
        </span>
      )}
    </button>
  );
}

interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  canCloseTab: (tab: WorkspaceTab) => boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: (kind: TabKind, provider?: ProviderKind) => void;
  onReorderTab: (activeTabId: string, overTabId: string) => void;
}

export const WorkspaceTabBar = memo(function WorkspaceTabBar({
  tabs,
  activeTabId,
  canCloseTab,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onReorderTab,
}: WorkspaceTabBarProps) {
  const handleDragEnd = useCallback(
    (
      event: Parameters<NonNullable<React.ComponentProps<typeof DragDropProvider>["onDragEnd"]>>[0],
    ) => {
      const { source, target } = event.operation;
      if (!source || !target || source.id === target.id) return;
      onReorderTab(String(source.id), String(target.id));
    },
    [onReorderTab],
  );

  return (
    <DragDropProvider
      onDragEnd={handleDragEnd}
      sensors={[
        PointerSensor.configure({
          activationConstraints: [new PointerActivationConstraints.Distance({ value: 8 })],
        }),
      ]}
    >
      <div className="flex items-center gap-0 border-b border-border bg-background px-2">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const closable = canCloseTab(tab);
          return (
            <SortableTab
              key={tab.id}
              tab={tab}
              index={index}
              isActive={isActive}
              closable={closable}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
            />
          );
        })}

        {/* Add tab button */}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Add workspace tab"
                className="ml-1 size-6 shrink-0 text-muted-foreground hover:text-foreground"
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start" sideOffset={4}>
            <MenuItem onClick={() => onAddTab("provider", "claudeAgent")}>
              <ClaudeAI className="size-4" />
              New Claude Code
            </MenuItem>
            <MenuItem onClick={() => onAddTab("provider", "codex")}>
              <OpenAI className="size-4" />
              New Codex
            </MenuItem>
            <MenuItem onClick={() => onAddTab("terminal")}>
              <TerminalSquareIcon className="size-4" />
              New Terminal
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </DragDropProvider>
  );
});
