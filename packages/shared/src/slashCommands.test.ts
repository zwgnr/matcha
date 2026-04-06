import { describe, expect, it } from "vitest";

import { isLeadingSlashCommandInput } from "./slashCommands";

describe("isLeadingSlashCommandInput", () => {
  it("detects prompts that start with a slash command", () => {
    expect(isLeadingSlashCommandInput("/btw")).toBe(true);
    expect(isLeadingSlashCommandInput("  /prompts:draftpr FILE=README.md")).toBe(true);
  });

  it("ignores plain prompts and empty input", () => {
    expect(isLeadingSlashCommandInput("please review this")).toBe(false);
    expect(isLeadingSlashCommandInput("")).toBe(false);
    expect(isLeadingSlashCommandInput(undefined)).toBe(false);
  });
});
