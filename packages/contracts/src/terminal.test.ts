import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_ID,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWorkspaceInput,
  TerminalWriteInput,
} from "./terminal";

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("TerminalOpenInput", () => {
  it("accepts valid open input", () => {
    expect(
      decodes(TerminalOpenInput, {
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        cols: 120,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("rejects invalid bounds", () => {
    expect(
      decodes(TerminalOpenInput, {
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        cols: 10,
        rows: 2,
      }),
    ).toBe(false);
  });

  it("defaults terminalId when missing", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 100,
      rows: 24,
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });

  it("accepts optional env overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      worktreePath: "/tmp/project/.matcha/worktrees/feature-a",
      cols: 100,
      rows: 24,
      env: {
        MATCHA_PROJECT_ROOT: "/tmp/project",
        CUSTOM_FLAG: "1",
      },
    });
    expect(parsed.env).toMatchObject({
      MATCHA_PROJECT_ROOT: "/tmp/project",
      CUSTOM_FLAG: "1",
    });
    expect(parsed.worktreePath).toBe("/tmp/project/.matcha/worktrees/feature-a");
  });

  it("rejects invalid env keys", () => {
    expect(
      decodes(TerminalOpenInput, {
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
        env: {
          "bad-key": "1",
        },
      }),
    ).toBe(false);
  });
});

describe("TerminalWriteInput", () => {
  it("accepts non-empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        workspaceId: "workspace-1",
        data: "echo hello\n",
      }),
    ).toBe(true);
  });

  it("rejects empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        workspaceId: "workspace-1",
        data: "",
      }),
    ).toBe(false);
  });
});

describe("TerminalWorkspaceInput", () => {
  it("trims workspace ids", () => {
    const parsed = decodeSync(TerminalWorkspaceInput, { workspaceId: " workspace-1 " });
    expect(parsed.workspaceId).toBe("workspace-1");
  });
});

describe("TerminalResizeInput", () => {
  it("accepts valid size", () => {
    expect(
      decodes(TerminalResizeInput, {
        workspaceId: "workspace-1",
        cols: 80,
        rows: 24,
      }),
    ).toBe(true);
  });
});

describe("TerminalClearInput", () => {
  it("defaults terminal id", () => {
    const parsed = decodeSync(TerminalClearInput, {
      workspaceId: "workspace-1",
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });
});

describe("TerminalCloseInput", () => {
  it("accepts optional deleteHistory", () => {
    expect(
      decodes(TerminalCloseInput, {
        workspaceId: "workspace-1",
        deleteHistory: true,
      }),
    ).toBe(true);
  });
});

describe("TerminalSessionSnapshot", () => {
  it("accepts running snapshots", () => {
    expect(
      decodes(TerminalSessionSnapshot, {
        workspaceId: "workspace-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running",
        pid: 1234,
        history: "hello\n",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(true);
  });
});

describe("TerminalEvent", () => {
  it("accepts output events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "output",
        workspaceId: "workspace-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: new Date().toISOString(),
        data: "line\n",
      }),
    ).toBe(true);
  });

  it("accepts exited events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "exited",
        workspaceId: "workspace-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: new Date().toISOString(),
        exitCode: 0,
        exitSignal: null,
      }),
    ).toBe(true);
  });

  it("accepts activity events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "activity",
        workspaceId: "workspace-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: new Date().toISOString(),
        hasRunningSubprocess: true,
      }),
    ).toBe(true);
  });

  it("accepts started events with snapshot worktree metadata", () => {
    expect(
      decodes(TerminalEvent, {
        type: "started",
        workspaceId: "workspace-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: new Date().toISOString(),
        snapshot: {
          workspaceId: "workspace-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/tmp/project/.matcha/worktrees/feature-a",
          worktreePath: "/tmp/project/.matcha/worktrees/feature-a",
          status: "running",
          pid: 1234,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
        },
      }),
    ).toBe(true);
  });
});
