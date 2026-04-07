# Matcha

Matcha is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

## Installation

> [!WARNING]
> Matcha currently supports Codex and Claude.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`

### Run without installing

```bash
npx matcha
```

### Desktop app

Download the latest `.dmg` from [GitHub Releases](https://github.com/zwgnr/matcha/releases).

> [!NOTE]
> The app is not code-signed. On first launch, macOS will block it. To fix this:
>
> 1. Right-click the app and select **Open**, then confirm
> 2. Or run: `xattr -cr "/Applications/Matcha (Alpha).app"`

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

## Credits

Matcha is forked from [T3 Code](https://github.com/pingdotgg/t3code). Thanks to the T3 team for the original project.
