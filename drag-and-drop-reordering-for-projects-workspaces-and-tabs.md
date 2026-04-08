# Drag-and-Drop Reordering for Projects, Workspaces, and Tabs

## Context

The user wants drag-and-drop reordering for three areas: projects in the sidebar, workspaces within each project, and tabs in the workspace tab bar. Projects already have DnD using the old `@dnd-kit/core` + `@dnd-kit/sortable` packages, but only when sort order is set to "manual". Workspaces and tabs have no DnD.

**Key decisions from user:**

- **Remove all sort order settings** (`SidebarProjectSortOrder`, `SidebarWorkspaceSortOrder`) entirely. No "sort by updated_at / created_at / manual" concept.
- Default ordering is creation order. Users reorder via drag-and-drop, which persists.
- **Migrate to `@dnd-kit/react`** (new package from dndkit.com/react), removing the old packages.

---

## Step 1: Install new packages, remove old ones

**File: `apps/web/package.json`**

Remove:

- `@dnd-kit/core`, `@dnd-kit/modifiers`, `@dnd-kit/sortable`, `@dnd-kit/utilities`

Add:

- `@dnd-kit/react` (latest, currently 0.3.2)
- `@dnd-kit/helpers` (latest, currently 0.3.2)

Run: `bun install`

---

## Step 2: Remove sort order settings from contracts

**File: `packages/contracts/src/settings.ts`**

- Delete `SidebarProjectSortOrder` type, schema, and default (lines 18-20)
- Delete `SidebarWorkspaceSortOrder` type, schema, and default (lines 22-24)
- Remove both fields from `ClientSettingsSchema` (lines 30-35)

---

## Step 3: Clean up settings hook

**File: `apps/web/src/hooks/useSettings.ts`**

- Remove imports of `SidebarProjectSortOrder`, `SidebarWorkspaceSortOrder` (lines 24-25)
- Remove legacy migration checks for `sidebarProjectSortOrder` and `sidebarWorkspaceSortOrder` in `buildLegacyClientSettingsMigrationPatch()` (lines 209-215)

---

## Step 4: Simplify sorting logic

**File: `apps/web/src/components/Sidebar.logic.ts`**

- Delete `sortProjectsForSidebar()` (lines 555-591) and its helper `getProjectSortTimestamp()` (lines 537-553) — projects will always be in `projectOrder` order (creation order + manual reorder)
- Simplify `sortWorkspacesForSidebar()` (lines 496-507) — remove the `sortOrder` parameter. Always sort by creation order (`createdAt` ascending, stable fallback by id). Rename to `sortWorkspacesByCreatedAt()` for clarity.
- Simplify `getFallbackWorkspaceIdAfterDelete()` (lines 509-535) — remove `sortOrder` parameter, use the simplified sort
- Remove now-unused helpers: `getLatestUserMessageTimestamp()`, `getWorkspaceSortTimestamp()`, and the `SidebarWorkspaceSortInput` type (if only used by deleted functions)

**File: `apps/web/src/components/Sidebar.logic.test.ts`**

- Update/remove tests for deleted/changed functions (lines ~677-1030)
- Add tests for the simplified `sortWorkspacesByCreatedAt()`

---

## Step 5: Add workspace ordering state to uiStateStore

**File: `apps/web/src/uiStateStore.ts`**

Following the existing `projectOrder: ProjectId[]` pattern:

1. Extend `UiState` with `workspaceOrderByProjectId: Record<string, WorkspaceId[]>`
2. Extend `PersistedUiState` with `workspaceOrderByProjectId?: Record<string, string[]>` (workspace IDs are stable, no cwd mapping needed unlike projects)
3. Add to `initialState`
4. Add hydration/persistence for workspace order in `readPersistedState()` / `persistState()`
5. Add pure function `reorderWorkspaces(state, projectId, draggedWorkspaceId, targetWorkspaceId)` — same splice/insert pattern as `reorderProjects()`
6. Add pure function `setWorkspaceOrder(state, projectId, order)` — to capture initial order on first drag
7. Update `syncWorkspaces()` to clean up stale workspace IDs from `workspaceOrderByProjectId`
8. Expose both on the store interface

Reuse existing `orderItemsByPreferredIds()` from `Sidebar.logic.ts` (line 209) to apply stored order to workspace lists in the sidebar.

---

## Step 6: Add tab reordering to workspaceTabStore

**File: `apps/web/src/workspaceTabStore.ts`**

Add `reorderTabs` method:

```ts
reorderTabs: (workspaceWorkspaceId: WorkspaceId, activeTabId: string, overTabId: string) => void
```

Implementation: find indices of both tabs, splice/insert to reorder. Same pattern as `reorderProjects`. Persistence is automatic via existing zustand persist middleware.

---

## Step 7: Migrate sidebar DnD to @dnd-kit/react

**File: `apps/web/src/components/Sidebar.tsx`**

### 7a. Replace imports

Remove old: `DndContext`, `SortableContext`, `useSortable`, `CSS`, `useSensor`, `useSensors`, `PointerSensor`, `restrictToVerticalAxis`, `restrictToFirstScrollableAncestor`, `verticalListSortingStrategy`, and all old DnD event types.

Add new: `DragDropProvider` from `@dnd-kit/react`, `useSortable` from `@dnd-kit/react/sortable`.

### 7b. Replace `SortableProjectItem` (lines 615-650)

New API: `useSortable({ id, index, type: 'project' })` returns `{ ref, handleRef, isDragging }`. No more `setNodeRef`, `transform`, `transition`, `CSS.Translate`. The ref goes directly on the `<li>`.

### 7c. Create `SortableWorkspaceItem` component

```tsx
function SortableWorkspaceItem({ workspaceId, index, projectId, children }) {
  const { ref, isDragging } = useSortable({
    id: workspaceId,
    index,
    type: "workspace",
    group: projectId, // isolates workspace DnD within each project
  });
  return (
    <div ref={ref} className={isDragging ? "z-20 opacity-70" : ""}>
      {children}
    </div>
  );
}
```

### 7d. Remove all sort order gating

- Delete `isManualProjectSorting` variable and all conditional branches
- Remove `sortProjectsForSidebar()` call — projects are already in `projectOrder` from `orderedProjects` useMemo
- Delete `projectDnDSensors`, `projectCollisionDetection`, `handleProjectDragStart`, `handleProjectDragEnd`, `handleProjectDragCancel`
- Delete `dragInProgressRef`, `suppressProjectClickAfterDragRef` and all related logic

### 7e. Single DragDropProvider at sidebar level

Replace the conditional `DndContext`/plain render (lines 2304-2337) with a single `DragDropProvider` that wraps the project + workspace lists. Use `onDragEnd` to dispatch reorder actions based on the dragged item's type.

### 7f. Wire workspace ordering into renderedProjects

In the `renderedProjects` useMemo, apply stored workspace order via `orderItemsByPreferredIds()` after filtering:

```ts
const orderedWorkspaces = orderItemsByPreferredIds({
  items: sortedByCreatedAt,
  preferredIds: workspaceOrderByProjectId[project.id] ?? [],
  getId: (w) => w.id,
});
```

### 7g. Wrap workspace rows in SortableWorkspaceItem

In the workspace rendering (lines 1899-1932), wrap each `SidebarWorkspaceRow` in `SortableWorkspaceItem` with correct `index` and `projectId`.

### 7h. Handle autoAnimate interaction

When DnD is active, `@formkit/auto-animate` can conflict. Since DnD is always enabled now, consider removing or conditionally skipping auto-animate on sortable lists. Test whether they coexist.

---

## Step 8: Add tab DnD in WorkspaceTabBar

**File: `apps/web/src/components/chat/WorkspaceTabBar.tsx`**

### 8a. Create `SortableTab` component

Extract the tab button into a `SortableTab` that uses `useSortable({ id: tab.id, index })`. The `ref` goes on the button element.

### 8b. Wrap tab list in DragDropProvider

```tsx
<DragDropProvider onDragEnd={handleTabDragEnd}>
  <div className="flex items-center gap-0 ...">
    {tabs.map((tab, index) => (
      <SortableTab key={tab.id} tab={tab} index={index} ... />
    ))}
    <Menu>...</Menu>  {/* Add tab button stays outside */}
  </div>
</DragDropProvider>
```

### 8c. Add `onReorderTab` prop

```ts
onReorderTab: (activeTabId: string, overTabId: string) => void;
```

**File: `apps/web/src/components/ChatView.tsx`** — Connect this prop to `useWorkspaceTabStore().reorderTabs()`.

---

## Step 9: Clean up workspace actions

**File: `apps/web/src/hooks/useWorkspaceActions.ts`**

- Remove `appSettings.sidebarWorkspaceSortOrder` usage (lines 130, 182)
- Update `getFallbackWorkspaceIdAfterDelete` call to not pass `sortOrder`

---

## Step 10: Update tests

- `apps/web/src/components/Sidebar.logic.test.ts` — Update sort function tests, remove sort order parameter tests
- `apps/web/src/uiStateStore.test.ts` — Add tests for `reorderWorkspaces()`, `setWorkspaceOrder()`
- Optionally add tests for `workspaceTabStore.reorderTabs()`

---

## Files Modified (Summary)

| File                                               | Change                                                    |
| -------------------------------------------------- | --------------------------------------------------------- |
| `apps/web/package.json`                            | Swap DnD packages                                         |
| `packages/contracts/src/settings.ts`               | Remove sort order types/schemas                           |
| `apps/web/src/hooks/useSettings.ts`                | Remove sort order imports/migration                       |
| `apps/web/src/components/Sidebar.logic.ts`         | Simplify/remove sort functions                            |
| `apps/web/src/components/Sidebar.logic.test.ts`    | Update tests                                              |
| `apps/web/src/uiStateStore.ts`                     | Add workspace order state + reorder                       |
| `apps/web/src/uiStateStore.test.ts`                | Add workspace reorder tests                               |
| `apps/web/src/workspaceTabStore.ts`                | Add `reorderTabs()`                                       |
| `apps/web/src/components/Sidebar.tsx`              | Major: migrate DnD, remove sort gating, add workspace DnD |
| `apps/web/src/components/chat/WorkspaceTabBar.tsx` | Add tab DnD                                               |
| `apps/web/src/components/ChatView.tsx`             | Connect tab reorder handler                               |
| `apps/web/src/hooks/useWorkspaceActions.ts`        | Remove sort order param                                   |

---

## Verification

1. `bun install` — packages install cleanly
2. `bun typecheck` — no type errors (sort order types fully removed)
3. `bun lint` && `bun fmt` — clean
4. `bun run test` — all tests pass
5. **Manual testing:**
   - Drag projects in sidebar — reorder persists across reload
   - Drag workspaces within a project — reorder persists, cannot drag to another project
   - Drag tabs in tab bar — reorder persists, active tab follows
   - New projects/workspaces appear at end of their list
   - Deleting a workspace navigates to adjacent workspace
   - Context menus still work on draggable items
