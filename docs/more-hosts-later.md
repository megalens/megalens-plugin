# More hosts: GitHub Copilot, OpenCode, and Antigravity (gated behind `MORE_HOSTS_ENABLED`)

These host setups are built in this plugin repository behind `MORE_HOSTS_ENABLED = false` in `scripts/hosts/more-hosts.mjs` and are **not yet available in the published `megalens-mcp` `0.3.12` npm release** (see [PLUGIN-NEEDS.md](../PLUGIN-NEEDS.md) #14).

Do not advertise the `npx megalens-mcp setup ...` commands in `README.md` until the matching `megalens-mcp` npm release ships `setup copilot`, `setup opencode`, and browser-login `setup antigravity` with terminal account confirmation.

## Planned one-line browser sign-in installs (pending `megalens-mcp` release)

| Host | Planned command (not yet in `0.3.12`) | First-run action in chat | Official docs |
|---|---|---|---|
| **GitHub Copilot** (VS Code Agent Mode & Copilot CLI) | `npx megalens-mcp setup copilot` | `"review my changes with MegaLens"` (via installed Agent Skill `SKILL.md`) | [VS Code MCP](https://code.visualstudio.com/docs/copilot/chat/mcp-servers), [Agent Skills / migration](https://code.visualstudio.com/docs/agent-customization/migrate-customizations#convert-prompt-files-to-skills), [Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli) |
| **OpenCode** | `npx megalens-mcp setup opencode` | `"review my changes with MegaLens"` or `/megalens-review` | [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [Commands](https://opencode.ai/docs/commands/), [Config](https://opencode.ai/docs/config/), [Rules](https://opencode.ai/docs/rules/) |
| **Antigravity** (`agy`) | `npx megalens-mcp setup antigravity` | `"review my changes with MegaLens"` | [Antigravity MCP](https://antigravity.google/docs/mcp), [Rules](https://antigravity.google/docs/rules), [Skills](https://antigravity.google/docs/skills) |

## Safety & host capability notes

- **Guarded collection before upload:** Hosted instructions and skills reuse the deterministic collector (`scripts/collect.mjs`) rather than asking the model to copy raw `git diff` or workspace files. If a host cannot run shell commands and neither `megalens_review_change` (`megalens-local`) nor another trusted deterministic sanitizing tool is available, the host must stop before uploading.
- **One billable review per request:** Hosted instructions forbid automatic retries on lost responses and forbid automatic follow-up calls when `needed_context` is returned (whether approved or halted). Because every `megalens_debate` call starts a new billable run, the host must ask the user before starting another review.
- **Browser sign-in account check:** Browser login (`--browser-login`) requires explicit terminal confirmation (`y`/`yes`) of the approved account before redeeming the token. Declining or closing stdin cancels the device code before any token is created.
- **No literal project tokens by default:** `--token-file` defaults to `--global` when `MORE_HOSTS_ENABLED` is on, and project-scope writes refuse literal tokens unless `--allow-project-token` is explicitly passed.
- **Config safety & precedence:** Unowned same-name MCP servers and customized/unowned command/skill/rule files are refused before writing. Deliberately disabled MegaLens entries (`enabled: false` / `disabled: true`) and unrelated custom fields are preserved. OpenCode respects `.opencode/opencode.json(c)` precedence and fails before sign-in if `XDG_CONFIG_HOME` points outside `--home`.
- **GitHub Copilot Extensions:** Server-side GitHub App Copilot Extensions were deprecated on September 24, 2025 and sunset on November 10, 2025 ([GitHub Changelog](https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/)); VS Code Agent Mode and Copilot CLI use MCP (`servers` in VS Code `mcp.json`, `mcpServers` in `~/.copilot/mcp-config.json`) and Agent Skills (`SKILL.md`).

## Preview from this repository

[Install from the checkout](../README.md#install-for-your-tool) to opt in for one host. The generic installer keeps its default.

## Generic installer after rollout

```sh
node scripts/install.mjs --host copilot|opencode|antigravity [--global|--project] [--mode local|hosted] [--browser-login] [--dir REPO] [--dry-run]
```
