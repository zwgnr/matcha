import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { mutateAsyncSpy } = vi.hoisted(() => ({
  mutateAsyncSpy: vi.fn().mockResolvedValue({ branch: "feature/renamed" }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQueryClient: vi.fn(() => ({})),
    useMutation: vi.fn(() => ({
      mutateAsync: mutateAsyncSpy,
      isPending: false,
    })),
  };
});

vi.mock("~/lib/gitReactQuery", () => ({
  gitRenameBranchMutationOptions: vi.fn(() => ({ __kind: "rename-branch" })),
}));

import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

describe("ChatHeader branch control", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the workspace title and renames the current branch inline", async () => {
    await render(
      <SidebarProvider>
        <ChatHeader
          activeWorkspaceTitle="Root Workspace"
          activeProjectName="Matcha"
          activeProjectId={undefined}
          activeWorkspaceId={undefined}
          currentBranch="feature/original"
          activeWorkspaceWorktreePath="/repo/.worktrees/root-workspace"
          isGitRepo
          openInCwd="/repo/project"
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={["cursor"]}
          sourceControlToggleShortcutLabel={null}
          sourceControlOpen={false}
          onRunProjectScript={() => undefined}
          onAddProjectScript={async () => undefined}
          onUpdateProjectScript={async () => undefined}
          onDeleteProjectScript={async () => undefined}
          onStartRunCommand={() => undefined}
          onStopRunCommand={() => undefined}
          onOpenPort={() => undefined}
          onToggleSourceControl={() => undefined}
        />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Root Workspace")).toBeInTheDocument();
    await expect
      .element(page.getByTestId("chat-header-branch-button"))
      .toContain("feature/original");
    await expect.element(page.getByText("Worktree")).toBeInTheDocument();

    await page.getByTestId("chat-header-branch-button").click();
    const input = page.getByTestId("chat-header-branch-input");
    await input.fill("feature/renamed");
    await page.getByText("Root Workspace").click();

    expect(mutateAsyncSpy).toHaveBeenCalledWith({
      oldBranch: "feature/original",
      newBranch: "feature/renamed",
    });
  });
});
