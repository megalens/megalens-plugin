# MegaLens for Codex (CLI + Desktop App)

Independent multi-company code review inside **Codex CLI** and the **Codex desktop app** (ChatGPT desktop app). One command starts the review, waits up to 20 minutes while it runs, and shows findings inline.

## Install from this checkout

Run `node codex/scripts/setup.mjs` from the repository root. It installs the preview and opens browser sign in. For setup from another directory, use the two commands below.

```sh
MEGALENS_CODEX_PLUGIN=1 npx --yes --package github:megalens/megalens-claude-plugin megalens-codex-install --with-oauth-mcp
codex mcp login megalens
```

*(From a local checkout of this repo, line 1 can be `MEGALENS_CODEX_PLUGIN=1 node /path/to/megalens-claude-plugin/codex/scripts/install-codex.mjs --with-oauth-mcp`.)*

> **Feature flag (default OFF):** Until release, both the installer and command runner are gated behind `CODEX_PLUGIN_ENABLED = false` (and the native marketplace policy ships as `"installation": "NOT_AVAILABLE"`). Running line 1 with `MEGALENS_CODEX_PLUGIN=1` saves an explicit preview opt-in inside user-owned `~/.codex/plugins/megalens/`, so `$megalens-review` works immediately after restarting **Codex CLI** or the **Codex desktop app** without exporting any shell variable. Set `MEGALENS_CODEX_PLUGIN=0` at any time to disable it again. Once `CODEX_PLUGIN_ENABLED` is flipped to `true` on release, line 1 drops the `MEGALENS_CODEX_PLUGIN=1` prefix.

What those two lines do:
1. **`megalens-codex-install --with-oauth-mcp`** (`install-codex.mjs`) copies the self-contained MegaLens plugin and runtime into user-owned `~/.codex/plugins/megalens/` (never inside any repository under review, and never dependent on a temporary `npx` cache), writes `[mcp_servers.megalens]` (`https://megalens.ai/api/mcp?ide=codex`) into `~/.codex/config.toml` / `$CODEX_HOME/config.toml` using TOML-aware merge (handling inline tables, quoted keys, and existing entries without aborting), and installs:
   - **Codex Skills** (`~/.agents/skills/megalens-{review,status,result}/`, explicit-invocation only via `agents/openai.yaml`) — works in Codex CLI (`$megalens-review`) and Codex desktop app (Skills / `@`).
   - **Codex CLI Custom Prompts** (`~/.codex/prompts/megalens-{review,status,result}.md`) — slash commands `/prompts:megalens-review`, `/prompts:megalens-status`, `/prompts:megalens-result`.
   - **Local Codex Plugin + Marketplace entry** (`~/.codex/plugins/megalens/` + `~/.agents/plugins/marketplace.json`) — discoverable in `codex /plugins` and the Codex desktop app **Plugins** tab.
2. **`codex mcp login megalens`** opens native browser OAuth sign-in against `https://megalens.ai` (zero token copy, no manual token paste, works on fresh profiles even when other editors are already installed). Codex CLI and the Codex desktop app share `$CODEX_HOME/config.toml` and the OAuth login automatically. *(Note: external package `megalens-mcp@0.3.12` is not required here; its `setup codex` still prompts for a manual token and its generic `setup` skips Codex when `~/.codex/config.toml` does not exist yet and another editor is detected — tracked in `PLUGIN-NEEDS.md` #14.)*

Restart Codex (CLI or desktop app) after installing.

## GitHub repository prerequisites (while `APP_PATH_ENABLED = false`)

`codex mcp login megalens` signs in your Codex editor MCP config (`~/.codex/config.toml`) only. Because the MegaLens GitHub App runner is disabled behind `APP_PATH_ENABLED = false` until the on-demand server endpoints are live, running `$megalens-review` on a GitHub repository currently uses your repository's **GitHub Actions workflow** and requires:

1. **GitHub CLI authenticated:** `gh auth login`
2. **Dispatch workflow on the repository's default branch:** `.github/workflows/megalens-dispatch.yml` (run `$megalens-review --runner github` to print the workflow template).
3. **Repository secret `MEGALENS_TOKEN`:** use the [shared GitHub Actions setup](../README.md#github-actions-setup). If browser setup is unavailable, use `gh secret set MEGALENS_TOKEN` at the private prompt.


## Run a review (one command)

- **Codex CLI or Desktop App (Standalone Skill — recommended):**
  ```text
  $megalens-review
  ```
- **Codex CLI or Desktop App (Native Plugin-scoped Skill):**
  ```text
  $megalens:megalens-review
  ```
- **Codex CLI (Custom slash prompt):**
  ```text
  /prompts:megalens-review
  ```

Standard is the default tier. For a deeper pass, run `$megalens-review deep` (or `/prompts:megalens-review deep`).

If you stop waiting or reach the 20-minute cap, MegaLens prints `Still running. Run $megalens-result to see it.` You can check progress with `$megalens-status` (`/prompts:megalens-status`) and fetch findings with `$megalens-result` (`/prompts:megalens-result`) without passing an ID.

## Runner order (identical to MegaLens for Claude Code)

1. **MegaLens GitHub App** — disabled behind `APP_PATH_ENABLED = false` until the on-demand server endpoints are live.
2. **GitHub Actions workflow** (`.github/workflows/megalens-dispatch.yml` on the repository's default branch) — dispatches the run, streams progress up to 20 minutes, and prints findings inline.
3. **Missing setup** — prints explicit GitHub Actions workflow setup instructions (with `https://megalens.ai/app/start`) while `APP_PATH_ENABLED = false`, never directing users to install a disabled App.
   Never falls back silently to a local engine, never pushes commits without your OK, and never prints tokens.

## Codex Desktop App MCP configuration

Codex CLI and the Codex desktop app share `~/.codex/config.toml` (`$CODEX_HOME/config.toml`). Passing `--with-oauth-mcp` to `megalens-codex-install` merges `[mcp_servers.megalens]` cleanly into `config.toml` (TOML-aware lookup and inline-table insertion; never overwrites an existing `mcp_servers.megalens` entry in any TOML form, including inline tables or quoted keys), and `codex mcp login megalens` completes native browser OAuth with zero token copy. See [`config.desktop.example.toml`](config.desktop.example.toml) for the exact TOML block.

## Advanced

- **Project-scoped install (repo skills only; runtime stays in user storage and `.git/info/exclude` keeps the worktree clean):**
  ```sh
  MEGALENS_CODEX_PLUGIN=1 node codex/scripts/install-codex.mjs --project --dir /path/to/repo
  ```
  Project installs never place executable scripts, opt-in markers, or marketplace packages inside the repository under review — the self-contained runtime always lives under `$CODEX_HOME/plugins/megalens/`, and installed skill paths are added to local `.git/info/exclude` so default `$megalens-review` does not reject them as uncommitted changes.
- **Native Codex CLI marketplace install (gated OFF while `CODEX_PLUGIN_ENABLED = false`):**
  The repository marketplace (`codex/.agents/plugins/marketplace.json`) ships with `"installation": "NOT_AVAILABLE"` until release, so `codex plugin add megalens@megalens` refuses to activate while the feature flag is OFF. Once `CODEX_PLUGIN_ENABLED` is flipped to `true` and `"installation"` is set to `"AVAILABLE"`, native marketplace install exposes the plugin MCP server (`megalens`) and plugin-namespaced skills (`$megalens:megalens-review`, `$megalens:megalens-status`, `$megalens:megalens-result`):
  ```sh
  codex plugin marketplace add ./codex
  codex plugin add megalens@megalens
  ```
- **Advanced review flags** (only when you explicitly pass them):
  - `--runner github|local`
  - `--base REF --head REF`
  - `--quiet`
  - `--no-wait`
  - `$megalens-status <id>` / `$megalens-result <id>` (`gh:<run-id>` or `rv_<id>`)

## Privacy

Read https://megalens.ai/privacy before reviewing code you do not own or that is under NDA. Finding text comes from a model: verify each finding against your code before acting on it.
