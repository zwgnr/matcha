import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNamedWorktreeBranchName,
  buildNewWorkspaceWorktreeBranchName,
  buildTemporaryWorktreeBranchName,
} from "./worktree";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildTemporaryWorktreeBranchName", () => {
  it("uses the temporary matcha/<token> shape", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
    } satisfies Pick<Crypto, "randomUUID">);

    const result = buildTemporaryWorktreeBranchName();

    expect(result).toBe("matcha/01234567");
  });
});

describe("buildNamedWorktreeBranchName", () => {
  it("sanitizes arbitrary names into matcha-prefixed branches", () => {
    expect(buildNamedWorktreeBranchName("Fix Sidebar Layout")).toBe("matcha/fix-sidebar-layout");
  });

  it("avoids double-prefixing existing matcha branches", () => {
    expect(buildNamedWorktreeBranchName("matcha/feature/demo")).toBe("matcha/feature/demo");
  });
});

describe("buildNewWorkspaceWorktreeBranchName", () => {
  it("uses the workspace name when provided", () => {
    expect(buildNewWorkspaceWorktreeBranchName("API Refactor")).toBe("matcha/api-refactor");
  });

  it("falls back to a temporary branch when the workspace name is blank", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "89abcdef-0123-4567-89ab-cdef01234567",
    } satisfies Pick<Crypto, "randomUUID">);

    const result = buildNewWorkspaceWorktreeBranchName("   ");

    expect(result).toBe("matcha/89abcdef");
  });
});
