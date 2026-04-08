import { WorkspaceId } from "@matcha/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeProviderTab,
  sanitizeWorkspaceTabPersistenceState,
  useWorkspaceTabStore,
} from "./workspaceTabStore";

describe("workspaceTabStore", () => {
  beforeEach(() => {
    useWorkspaceTabStore.persist.clearStorage();
    useWorkspaceTabStore.setState({
      tabStateByRootWorkspaceId: {},
      rootWorkspaceIdByWorkspaceId: {},
    });
  });

  it("keeps explicit root ownership after closing a child provider tab", () => {
    const rootWorkspaceId = WorkspaceId.makeUnsafe("workspace-root");
    const childWorkspaceId = WorkspaceId.makeUnsafe("workspace-child");
    const store = useWorkspaceTabStore.getState();

    store.getOrInitTabs(rootWorkspaceId);
    store.addTab(rootWorkspaceId, makeProviderTab("codex", rootWorkspaceId));
    const childTab = makeProviderTab("codex", childWorkspaceId);
    store.addTab(rootWorkspaceId, childTab);

    expect(useWorkspaceTabStore.getState().findRootWorkspaceId(childWorkspaceId)).toBe(
      rootWorkspaceId,
    );
    expect(useWorkspaceTabStore.getState().findGroupedWorkspaceIds(rootWorkspaceId)).toEqual([
      childWorkspaceId,
    ]);

    useWorkspaceTabStore.getState().removeTab(rootWorkspaceId, childTab.id);

    expect(useWorkspaceTabStore.getState().findRootWorkspaceId(childWorkspaceId)).toBe(
      rootWorkspaceId,
    );
    expect(useWorkspaceTabStore.getState().findGroupedWorkspaceIds(rootWorkspaceId)).toEqual([
      childWorkspaceId,
    ]);
    expect(
      useWorkspaceTabStore.getState().findTabByWorkspaceId(rootWorkspaceId, childWorkspaceId),
    ).toBeUndefined();
  });

  it("sanitizes legacy persisted tab state into unique explicit root ownership", () => {
    const rootWorkspaceId = WorkspaceId.makeUnsafe("workspace-root");
    const otherRootWorkspaceId = WorkspaceId.makeUnsafe("workspace-other-root");
    const childWorkspaceId = WorkspaceId.makeUnsafe("workspace-child");

    const sanitized = sanitizeWorkspaceTabPersistenceState({
      tabStateByRootWorkspaceId: {
        [rootWorkspaceId]: {
          tabs: [
            makeProviderTab("codex", rootWorkspaceId),
            makeProviderTab("codex", childWorkspaceId),
          ],
          activeTabId: "",
        },
        [otherRootWorkspaceId]: {
          tabs: [makeProviderTab("codex", childWorkspaceId)],
          activeTabId: "",
        },
      },
      rootWorkspaceIdByWorkspaceId: {
        [rootWorkspaceId]: rootWorkspaceId,
        [otherRootWorkspaceId]: otherRootWorkspaceId,
        [childWorkspaceId]: rootWorkspaceId,
      },
    });

    expect(sanitized.rootWorkspaceIdByWorkspaceId).toMatchObject({
      [rootWorkspaceId]: rootWorkspaceId,
      [otherRootWorkspaceId]: otherRootWorkspaceId,
      [childWorkspaceId]: rootWorkspaceId,
    });
    expect(
      sanitized.tabStateByRootWorkspaceId[rootWorkspaceId]?.tabs.filter(
        (tab) => tab.kind === "provider" && tab.workspaceId === childWorkspaceId,
      ),
    ).toHaveLength(1);
    expect(
      sanitized.tabStateByRootWorkspaceId[otherRootWorkspaceId]?.tabs.some(
        (tab) => tab.kind === "provider" && tab.workspaceId === childWorkspaceId,
      ),
    ).toBe(false);
  });
});
