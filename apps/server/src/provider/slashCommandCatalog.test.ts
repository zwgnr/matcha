import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { afterEach, describe, it } from "vitest";

import { discoverClaudeSlashCommands, discoverCodexSlashCommands } from "./slashCommandCatalog";

const tempDirectories = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await fsPromises.mkdtemp(join(os.tmpdir(), "matcha-slash-catalog-"));
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

describe("discoverClaudeSlashCommands", () => {
  it("discovers project, home, and plugin Claude slash commands", async () => {
    const cwd = await makeTempDir();
    const homeDir = await makeTempDir();

    await fsPromises.mkdir(join(homeDir, ".claude", "commands"), { recursive: true });
    await fsPromises.mkdir(join(cwd, ".claude", "commands", "team"), { recursive: true });
    await fsPromises.mkdir(join(homeDir, ".claude", "skills", "worktree"), { recursive: true });
    await fsPromises.mkdir(join(cwd, ".claude", "skills", "hidden-skill"), { recursive: true });
    await fsPromises.mkdir(
      join(
        homeDir,
        ".claude",
        "plugins",
        "cache",
        "claude-plugins-official",
        "ralph-loop",
        "1.0.0",
      ),
      { recursive: true },
    );
    await fsPromises.mkdir(
      join(
        homeDir,
        ".claude",
        "plugins",
        "cache",
        "claude-plugins-official",
        "frontend-design",
        "unknown",
        "skills",
        "frontend-design",
      ),
      { recursive: true },
    );
    await fsPromises.mkdir(
      join(
        homeDir,
        ".claude",
        "plugins",
        "cache",
        "claude-plugins-official",
        "ralph-loop",
        "1.0.0",
        "commands",
      ),
      { recursive: true },
    );
    await fsPromises.mkdir(
      join(
        homeDir,
        ".claude",
        "plugins",
        "marketplaces",
        "claude-plugins-official",
        "plugins",
        "security-review",
        "commands",
      ),
      { recursive: true },
    );
    await fsPromises.writeFile(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            "ralph-loop@claude-plugins-official": [
              {
                installPath: join(
                  homeDir,
                  ".claude",
                  "plugins",
                  "cache",
                  "claude-plugins-official",
                  "ralph-loop",
                  "1.0.0",
                ),
              },
            ],
            "frontend-design@claude-plugins-official": [
              {
                installPath: join(
                  homeDir,
                  ".claude",
                  "plugins",
                  "cache",
                  "claude-plugins-official",
                  "frontend-design",
                  "unknown",
                ),
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    await fsPromises.writeFile(
      join(homeDir, ".claude", "skills", "worktree", "SKILL.md"),
      "---\nname: worktree\ndescription: Manage worktrees\n---\nUse this command.",
    );
    await fsPromises.writeFile(
      join(cwd, ".claude", "commands", "team", "shipit.md"),
      "---\ndescription: Ship it\n---\nUse this command.",
    );
    await fsPromises.writeFile(
      join(cwd, ".claude", "skills", "hidden-skill", "SKILL.md"),
      "---\nname: hidden-skill\nuser-invocable: false\n---\nHidden command.",
    );
    await fsPromises.writeFile(
      join(
        homeDir,
        ".claude",
        "plugins",
        "cache",
        "claude-plugins-official",
        "ralph-loop",
        "1.0.0",
        "commands",
        "ralph-loop.md",
      ),
      "---\ndescription: Run Ralph Loop\n---\nUse this command.",
    );
    await fsPromises.writeFile(
      join(
        homeDir,
        ".claude",
        "plugins",
        "cache",
        "claude-plugins-official",
        "frontend-design",
        "unknown",
        "skills",
        "frontend-design",
        "SKILL.md",
      ),
      "---\ndescription: Design a frontend\n---\nUse this skill.",
    );
    await fsPromises.writeFile(
      join(
        homeDir,
        ".claude",
        "plugins",
        "marketplaces",
        "claude-plugins-official",
        "plugins",
        "security-review",
        "commands",
        "security-review.md",
      ),
      "---\ndescription: Complete a security review\n---\nUse this command.",
    );

    const commands = await discoverClaudeSlashCommands(cwd, homeDir);

    assert(commands.some((command) => command.command === "/worktree"));
    assert(commands.some((command) => command.command === "/team:shipit"));
    assert(commands.some((command) => command.command === "/ralph-loop:ralph-loop"));
    assert(commands.some((command) => command.command === "/frontend-design:frontend-design"));
    assert(commands.some((command) => command.command === "/security-review:security-review"));
    assert(commands.every((command) => command.command !== "/hidden-skill"));
  });
});

describe("discoverCodexSlashCommands", () => {
  it("discovers project and home custom prompts", async () => {
    const cwd = await makeTempDir();
    const homeDir = await makeTempDir();

    await fsPromises.mkdir(join(homeDir, ".codex", "prompts"), { recursive: true });
    await fsPromises.mkdir(join(cwd, ".codex", "prompts"), { recursive: true });
    await fsPromises.writeFile(
      join(homeDir, ".codex", "prompts", "draftpr.md"),
      "---\ndescription: Draft a PR\n---\nPrompt",
    );
    await fsPromises.writeFile(
      join(cwd, ".codex", "prompts", "triage.md"),
      "---\ndescription: Triage a bug\n---\nPrompt",
    );

    const commands = await discoverCodexSlashCommands(cwd, homeDir);

    assert.deepStrictEqual(
      commands.map((command) => command.command),
      ["/prompts:draftpr", "/prompts:triage"],
    );
  });
});
