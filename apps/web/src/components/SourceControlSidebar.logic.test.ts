import type { GitStatusResult } from "@matcha/contracts";
import { assert, describe, it } from "vitest";
import { resolveWorkingChanges } from "./SourceControlSidebar.logic";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    hasOriginRemote: true,
    isDefaultBranch: false,
    branch: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
      staged: [],
      unstaged: [],
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveWorkingChanges", () => {
  it("returns live working tree files when git reports changes", () => {
    const changes = resolveWorkingChanges(
      status({
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/app.ts", insertions: 3, deletions: 1 }],
          insertions: 3,
          deletions: 1,
          staged: [],
          unstaged: [{ path: "src/app.ts", insertions: 3, deletions: 1 }],
        },
      }),
    );

    assert.deepEqual(changes, [{ path: "src/app.ts", additions: 3, deletions: 1 }]);
  });

  it("does not fall back to historical turn diffs when git status is clean", () => {
    const changes = resolveWorkingChanges(status());

    assert.deepEqual(changes, []);
  });

  it("keeps zero-stat git entries untouched instead of consulting turn data", () => {
    const changes = resolveWorkingChanges(
      status({
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/new-file.ts", insertions: 0, deletions: 0 }],
          insertions: 0,
          deletions: 0,
          staged: [],
          unstaged: [{ path: "src/new-file.ts", insertions: 0, deletions: 0 }],
        },
      }),
    );

    assert.deepEqual(changes, [{ path: "src/new-file.ts", additions: 0, deletions: 0 }]);
  });
});
