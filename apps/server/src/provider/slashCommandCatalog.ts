import fsPromises from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join, relative } from "node:path";

import type { ServerProviderSlashCommand } from "@matcha/contracts";

import { parseCodexCustomPromptTemplate } from "./codexCustomPrompts";

async function listMarkdownFiles(root: string, recursive: boolean): Promise<string[]> {
  try {
    const stat = await fsPromises.stat(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...(await listMarkdownFiles(absolutePath, true)));
      }
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function listSkillFiles(root: string): Promise<string[]> {
  try {
    const stat = await fsPromises.stat(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fsPromises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

function commandNameFromMarkdownPath(root: string, filePath: string, separator: ":" | ""): string {
  const relativePath = relative(root, filePath).replace(/\\/g, "/");
  const withoutExtension = relativePath.replace(/\.md$/i, "");
  return separator ? withoutExtension.split("/").join(separator) : withoutExtension;
}

async function readCommandDescription(filePath: string): Promise<string | undefined> {
  try {
    const markdown = await fsPromises.readFile(filePath, "utf8");
    return parseCodexCustomPromptTemplate(markdown).description ?? undefined;
  } catch {
    return undefined;
  }
}

interface ClaudeSkillMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocable?: boolean;
}

interface ClaudeInstalledPluginsManifest {
  readonly plugins?: Readonly<Record<string, ReadonlyArray<{ readonly installPath?: string }>>>;
}

interface ClaudePluginRoot {
  readonly namespace: string;
  readonly root: string;
}

function parseClaudeFrontmatter(markdown: string): ClaudeSkillMetadata {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {};
  }

  const closingBoundaryIndex = normalized.indexOf("\n---\n", 4);
  if (closingBoundaryIndex === -1) {
    return {};
  }

  const frontmatter = normalized.slice(4, closingBoundaryIndex);
  const metadata: {
    name?: string;
    description?: string;
    userInvocable?: boolean;
  } = {};

  for (const line of frontmatter.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key === "name" && value.length > 0) {
      metadata.name = value;
      continue;
    }
    if (key === "description" && value.length > 0) {
      metadata.description = value;
      continue;
    }
    if (key === "user-invocable") {
      metadata.userInvocable = value.toLowerCase() !== "false";
    }
  }

  return metadata;
}

function mergeSlashCommands(
  sources: ReadonlyArray<ReadonlyArray<ServerProviderSlashCommand>>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const merged = new Map<string, ServerProviderSlashCommand>();
  for (const source of sources) {
    for (const command of source) {
      merged.set(command.command, command);
    }
  }
  return [...merged.values()].toSorted((left, right) => left.command.localeCompare(right.command));
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const stat = await fsPromises.stat(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

function prefixSlashCommands(
  namespace: string,
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return commands.map((command) =>
    command.description
      ? ({
          command: `/${namespace}:${command.command.slice(1)}`,
          description: command.description,
        } satisfies ServerProviderSlashCommand)
      : ({
          command: `/${namespace}:${command.command.slice(1)}`,
        } satisfies ServerProviderSlashCommand),
  );
}

async function discoverCustomClaudeCommands(
  root: string,
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  const files = await listMarkdownFiles(root, true);
  const commands = await Promise.all(
    files.map(async (filePath) => {
      const markdown = await fsPromises.readFile(filePath, "utf8");
      const metadata = parseClaudeFrontmatter(markdown);
      if (metadata.userInvocable === false) {
        return null;
      }

      const commandName = metadata.name?.trim() || commandNameFromMarkdownPath(root, filePath, ":");
      if (!commandName) {
        return null;
      }

      return metadata.description
        ? ({
            command: `/${commandName}`,
            description: metadata.description,
          } satisfies ServerProviderSlashCommand)
        : ({ command: `/${commandName}` } satisfies ServerProviderSlashCommand);
    }),
  );
  return commands.filter((command) => command !== null);
}

async function discoverClaudeSkills(
  root: string,
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  const files = await listSkillFiles(root);
  const commands = await Promise.all(
    files.map(async (filePath) => {
      const markdown = await fsPromises.readFile(filePath, "utf8");
      const metadata = parseClaudeFrontmatter(markdown);
      if (metadata.userInvocable === false) {
        return null;
      }

      const skillDirectoryName = basename(dirname(filePath));
      const commandName = metadata.name?.trim() || skillDirectoryName;
      if (!commandName) {
        return null;
      }

      return metadata.description
        ? ({
            command: `/${commandName}`,
            description: metadata.description,
          } satisfies ServerProviderSlashCommand)
        : ({ command: `/${commandName}` } satisfies ServerProviderSlashCommand);
    }),
  );

  return commands.filter((command) => command !== null);
}

async function readInstalledClaudePluginRoots(
  homeDir: string,
): Promise<ReadonlyArray<ClaudePluginRoot>> {
  const manifestPath = join(homeDir, ".claude", "plugins", "installed_plugins.json");
  try {
    const manifest = JSON.parse(
      await fsPromises.readFile(manifestPath, "utf8"),
    ) as ClaudeInstalledPluginsManifest;
    return Object.entries(manifest.plugins ?? {}).flatMap(([pluginId, entries]) => {
      const namespace = pluginId.split("@", 1)[0]?.trim();
      if (!namespace) {
        return [];
      }
      return entries
        .map((entry) => entry.installPath?.trim())
        .filter((installPath): installPath is string => Boolean(installPath))
        .map(
          (installPath) =>
            ({
              namespace,
              root: installPath,
            }) satisfies ClaudePluginRoot,
        );
    });
  } catch {
    return [];
  }
}

async function discoverMarketplaceClaudePluginRoots(
  homeDir: string,
): Promise<ReadonlyArray<ClaudePluginRoot>> {
  const marketplacesRoot = join(homeDir, ".claude", "plugins", "marketplaces");
  const marketplaceRoots = await listDirectories(marketplacesRoot);
  const pluginRoots = await Promise.all(
    marketplaceRoots.map(async (marketplaceRoot) =>
      listDirectories(join(marketplaceRoot, "plugins")),
    ),
  );
  return pluginRoots.flat().map(
    (pluginRoot) =>
      ({
        namespace: basename(pluginRoot),
        root: pluginRoot,
      }) satisfies ClaudePluginRoot,
  );
}

async function discoverClaudePluginRoots(
  homeDir: string,
): Promise<ReadonlyArray<ClaudePluginRoot>> {
  const [installedRoots, marketplaceRoots] = await Promise.all([
    readInstalledClaudePluginRoots(homeDir),
    discoverMarketplaceClaudePluginRoots(homeDir),
  ]);

  const merged = new Map<string, ClaudePluginRoot>();
  for (const pluginRoot of [...installedRoots, ...marketplaceRoots]) {
    merged.set(`${pluginRoot.namespace}\0${pluginRoot.root}`, pluginRoot);
  }
  return [...merged.values()];
}

async function discoverClaudePluginSlashCommands(
  homeDir: string,
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  const pluginRoots = await discoverClaudePluginRoots(homeDir);
  const pluginCommands = await Promise.all(
    pluginRoots.map(async ({ namespace, root }) => {
      const [commands, skills] = await Promise.all([
        discoverCustomClaudeCommands(join(root, "commands")),
        discoverClaudeSkills(join(root, "skills")),
      ]);
      return prefixSlashCommands(namespace, commands).concat(
        prefixSlashCommands(namespace, skills),
      );
    }),
  );

  return mergeSlashCommands(pluginCommands);
}

async function discoverCustomCodexCommands(
  root: string,
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  const files = await listMarkdownFiles(root, false);
  const commands = await Promise.all(
    files.map(async (filePath) => {
      const commandName = commandNameFromMarkdownPath(root, filePath, "");
      const description = await readCommandDescription(filePath);
      return description
        ? ({
            command: `/prompts:${commandName}`,
            description,
          } satisfies ServerProviderSlashCommand)
        : ({ command: `/prompts:${commandName}` } satisfies ServerProviderSlashCommand);
    }),
  );
  return commands;
}

export async function discoverClaudeSlashCommands(
  cwd: string = process.cwd(),
  homeDir: string = os.homedir(),
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  const [projectCommands, homeCommands, projectSkills, homeSkills, pluginCommands] =
    await Promise.all([
      discoverCustomClaudeCommands(join(cwd, ".claude", "commands")),
      discoverCustomClaudeCommands(join(homeDir, ".claude", "commands")),
      discoverClaudeSkills(join(cwd, ".claude", "skills")),
      discoverClaudeSkills(join(homeDir, ".claude", "skills")),
      discoverClaudePluginSlashCommands(homeDir),
    ]);
  return mergeSlashCommands([
    pluginCommands,
    homeCommands,
    projectCommands,
    homeSkills,
    projectSkills,
  ]);
}

export async function discoverCodexSlashCommands(
  cwd: string = process.cwd(),
  homeDir: string = os.homedir(),
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  const projectCommands = await discoverCustomCodexCommands(join(cwd, ".codex", "prompts"));
  const homeCommands = await discoverCustomCodexCommands(join(homeDir, ".codex", "prompts"));
  return mergeSlashCommands([homeCommands, projectCommands]);
}
