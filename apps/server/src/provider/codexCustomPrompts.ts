import fsPromises from "node:fs/promises";
import { join } from "node:path";

export interface CodexCustomPromptInvocation {
  readonly promptName: string;
  readonly argumentsText: string;
}

export interface CodexCustomPromptTemplate {
  readonly body: string;
  readonly description: string | null;
  readonly argumentHint: string | null;
}

const CODEX_CUSTOM_PROMPT_PATTERN = /^\/prompts:([a-z0-9][a-z0-9._-]*)(?:\s+(.*))?$/i;
const CODEX_NAMED_ARGUMENT_PATTERN = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const FRONTMATTER_BOUNDARY = "---";
const ESCAPED_DOLLAR_SENTINEL = "__MATCHA_ESCAPED_DOLLAR__";

function unquoteValue(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const quote = value[0];
  if ((quote !== `"` && quote !== `'`) || value[value.length - 1] !== quote) {
    return value;
  }

  const inner = value.slice(1, -1);
  if (quote === '"') {
    return inner.replace(/\\(["\\])/g, "$1");
  }
  return inner.replace(/\\(['\\])/g, "$1");
}

export function parseCodexCustomPromptInvocation(
  input: string,
): CodexCustomPromptInvocation | null {
  const match = CODEX_CUSTOM_PROMPT_PATTERN.exec(input.trim());
  if (!match) {
    return null;
  }

  return {
    promptName: match[1]!.toLowerCase(),
    argumentsText: (match[2] ?? "").trim(),
  };
}

export function tokenizeSlashCommandArguments(argumentsText: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: `"` | `'` | null = null;

  for (let index = 0; index < argumentsText.length; index += 1) {
    const char = argumentsText[index]!;

    if (quote) {
      if (char === "\\" && index + 1 < argumentsText.length) {
        current += argumentsText[index + 1]!;
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === `"` || char === `'`) {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseFrontmatterValue(value: string): string {
  return unquoteValue(value.trim());
}

export function parseCodexCustomPromptTemplate(markdown: string): CodexCustomPromptTemplate {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_BOUNDARY}\n`)) {
    return {
      body: normalized.trim(),
      description: null,
      argumentHint: null,
    };
  }

  const closingBoundaryIndex = normalized.indexOf(`\n${FRONTMATTER_BOUNDARY}\n`, 4);
  if (closingBoundaryIndex === -1) {
    return {
      body: normalized.trim(),
      description: null,
      argumentHint: null,
    };
  }

  const frontmatter = normalized.slice(FRONTMATTER_BOUNDARY.length + 1, closingBoundaryIndex);
  const body = normalized.slice(closingBoundaryIndex + `\n${FRONTMATTER_BOUNDARY}\n`.length).trim();

  let description: string | null = null;
  let argumentHint: string | null = null;

  for (const line of frontmatter.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = parseFrontmatterValue(line.slice(separatorIndex + 1));
    if (!value) {
      continue;
    }
    if (key === "description") {
      description = value;
      continue;
    }
    if (key === "argument-hint") {
      argumentHint = value;
    }
  }

  return { body, description, argumentHint };
}

export function expandCodexCustomPromptBody(input: {
  readonly body: string;
  readonly argumentsText: string;
}): string {
  const tokens = tokenizeSlashCommandArguments(input.argumentsText);
  const normalizedTokens: string[] = [];
  const positionalArguments: string[] = [];
  const namedArguments = new Map<string, string>();

  for (const token of tokens) {
    const namedMatch = CODEX_NAMED_ARGUMENT_PATTERN.exec(token);
    if (namedMatch) {
      const normalizedValue = unquoteValue(namedMatch[2]!);
      namedArguments.set(namedMatch[1]!, normalizedValue);
      normalizedTokens.push(`${namedMatch[1]!}=${normalizedValue}`);
      continue;
    }
    positionalArguments.push(token);
    normalizedTokens.push(token);
  }

  const allArguments = normalizedTokens.join(" ").trim();

  return input.body
    .replaceAll("$$", ESCAPED_DOLLAR_SENTINEL)
    .replace(/\$ARGUMENTS|\$[1-9]|\$[A-Z][A-Z0-9_]*/g, (placeholder) => {
      if (placeholder === "$ARGUMENTS") {
        return allArguments;
      }

      if (/^\$[1-9]$/.test(placeholder)) {
        const position = Number.parseInt(placeholder.slice(1), 10) - 1;
        return positionalArguments[position] ?? "";
      }

      return namedArguments.get(placeholder.slice(1)) ?? "";
    })
    .replaceAll(ESCAPED_DOLLAR_SENTINEL, "$")
    .trim();
}

async function readPromptFile(path: string): Promise<string | null> {
  try {
    const stat = await fsPromises.stat(path);
    if (!stat.isFile()) {
      return null;
    }
    return await fsPromises.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function candidatePromptPaths(input: {
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly promptName: string;
}): string[] {
  const candidates: string[] = [];
  const filename = `${input.promptName}.md`;

  if (input.cwd) {
    candidates.push(join(input.cwd, ".codex", "prompts", filename));
  }
  if (input.homeDir) {
    candidates.push(join(input.homeDir, ".codex", "prompts", filename));
  }

  return [...new Set(candidates)];
}

export async function resolveCodexSlashCommandInput(input: {
  readonly text: string;
  readonly cwd?: string;
  readonly homeDir?: string;
}): Promise<string> {
  const invocation = parseCodexCustomPromptInvocation(input.text);
  if (!invocation) {
    return input.text;
  }

  for (const candidatePath of candidatePromptPaths({
    promptName: invocation.promptName,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  })) {
    const markdown = await readPromptFile(candidatePath);
    if (!markdown) {
      continue;
    }
    const template = parseCodexCustomPromptTemplate(markdown);
    const expanded = expandCodexCustomPromptBody({
      body: template.body,
      argumentsText: invocation.argumentsText,
    });
    return expanded.length > 0 ? expanded : input.text;
  }

  return input.text;
}
