import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { afterEach, describe, it } from "vitest";

import {
  expandCodexCustomPromptBody,
  parseCodexCustomPromptInvocation,
  parseCodexCustomPromptTemplate,
  resolveCodexSlashCommandInput,
  tokenizeSlashCommandArguments,
} from "./codexCustomPrompts";

const tempDirectories = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await fsPromises.mkdtemp(join(os.tmpdir(), "matcha-codex-prompts-"));
  tempDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map(async (directory) => {
      await fsPromises.rm(directory, { recursive: true, force: true });
      tempDirectories.delete(directory);
    }),
  );
});

describe("parseCodexCustomPromptInvocation", () => {
  it("parses codex custom prompt commands", () => {
    assert.deepStrictEqual(
      parseCodexCustomPromptInvocation('/prompts:draftpr FILES="src/index.ts"'),
      {
        promptName: "draftpr",
        argumentsText: 'FILES="src/index.ts"',
      },
    );
  });

  it("ignores non-custom prompt slash commands", () => {
    assert.equal(parseCodexCustomPromptInvocation("/review"), null);
  });
});

describe("tokenizeSlashCommandArguments", () => {
  it("preserves quoted values as a single token", () => {
    assert.deepStrictEqual(tokenizeSlashCommandArguments('one "two words" THREE=value'), [
      "one",
      "two words",
      "THREE=value",
    ]);
  });
});

describe("parseCodexCustomPromptTemplate", () => {
  it("extracts frontmatter metadata and prompt body", () => {
    const template = parseCodexCustomPromptTemplate(`---
description: Example prompt
argument-hint: FILE=<path>
---

Review $FILE.
`);

    assert.deepStrictEqual(template, {
      body: "Review $FILE.",
      description: "Example prompt",
      argumentHint: "FILE=<path>",
    });
  });
});

describe("expandCodexCustomPromptBody", () => {
  it("expands positional, named, and escaped dollar placeholders", () => {
    const expanded = expandCodexCustomPromptBody({
      body: "Ticket: $1\nFile: $FILE\nAll: $ARGUMENTS\nCost: $$5",
      argumentsText: '123 FILE="src/index.ts"',
    });

    assert.equal(expanded, "Ticket: 123\nFile: src/index.ts\nAll: 123 FILE=src/index.ts\nCost: $5");
  });
});

describe("resolveCodexSlashCommandInput", () => {
  it("prefers project-local prompts over home prompts", async () => {
    const cwd = await makeTempDir();
    const homeDir = await makeTempDir();

    await fsPromises.mkdir(join(cwd, ".codex", "prompts"), { recursive: true });
    await fsPromises.mkdir(join(homeDir, ".codex", "prompts"), { recursive: true });
    await fsPromises.writeFile(join(homeDir, ".codex", "prompts", "draftpr.md"), "Home prompt");
    await fsPromises.writeFile(join(cwd, ".codex", "prompts", "draftpr.md"), "Project prompt");

    const resolved = await resolveCodexSlashCommandInput({
      text: "/prompts:draftpr",
      cwd,
      homeDir,
    });

    assert.equal(resolved, "Project prompt");
  });

  it("expands prompt placeholders from a matching prompt file", async () => {
    const homeDir = await makeTempDir();
    await fsPromises.mkdir(join(homeDir, ".codex", "prompts"), { recursive: true });
    await fsPromises.writeFile(
      join(homeDir, ".codex", "prompts", "draftpr.md"),
      `---
description: Prep a draft PR
---

Commit $FILES with title $PR_TITLE.
`,
    );

    const resolved = await resolveCodexSlashCommandInput({
      text: '/prompts:draftpr FILES="src/index.ts" PR_TITLE="Add landing page"',
      homeDir,
    });

    assert.equal(resolved, "Commit src/index.ts with title Add landing page.");
  });

  it("leaves unknown slash commands untouched", async () => {
    const resolved = await resolveCodexSlashCommandInput({
      text: "/prompts:missing FILE=README.md",
    });

    assert.equal(resolved, "/prompts:missing FILE=README.md");
  });
});
