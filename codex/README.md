# MegaLens for Codex (CLI + Desktop App)

Independent multi-company code review inside **Codex CLI** and the **Codex desktop app** (ChatGPT desktop app). One command starts the review, waits up to 20 minutes while it runs, and shows findings inline.

## Install (2 lines, from any directory)

```sh
npx megalens-mcp setup
MEGALENS_CODEX_PLUGIN=1 npx --yes --package github:megalens/megalens-claude-plugin megalens-codex-install
```

*(From a local checkout of this repo, line 2 can be `MEGALENS_CODEX_PLUGIN=1 node /path/to/megalens-claude-plugin/codex/scripts/install-codex.mjs`.)*

> **Feature flag (default OFF):** Until release, both the installer and command runner are gated behind `CODEX_PLUGIN_ENABLED = false` (and the native marketplace policy ships as `"installation": "NOT_AVAILABLE"`). Running line 2 with `MEGALENS_CODEX_PLUGIN=1` saves an explicit preview opt-in inside `~/.codex/plugins/megalens/`, so `$megalens-review` works immediately after restarting **Codex CLI** or the **Codex desktop app** without exporting any shell variable. Set `MEGALENS_CODEX_PLUGIN=0` at any time to disable it again. Once `CODEX_PLUGIN_ENABLED` is flipped to `true` on release, line 2 drops the `MEGALENS_CODEX_PLUGIN=1` prefix.

What those two lines do:
1. **`npx megalens-mcp setup`** opens browser sign-in (no token copy) and writes `[mcp_servers.megalens]` into `~/.codex/config.toml` — shared automatically by **Codex CLI**, the **Codex desktop app**, and the Codex IDE extension. *(Note: in published `megalens-mcp@0.3.12`, the generic `setup` subcommand uses browser device sign-in; `setup codex` still prompts for a manual token until updated upstream in `github.com/megalens/mcp`.)*
2. **`megalens-codex-install`** (`install-codex.mjs`) copies the self-contained MegaLens plugin and runtime into `~/.codex/plugins/megalens/` (so it never depends on your checkout or a temporary `npx` cache and never resolves scripts from the repository under review) and installs:
   - **Codex Skills** (`~/.agents/skills/megalens-{review,status,result}/`, explicit-invocation only via `agents/openai.yaml`) — works in Codex CLI (`$megalens-review`) and Codex desktop app (Skills / `@`).
   - **Codex CLI Custom Prompts** (`~/.codex/prompts/megalens-{review,status,result}.md`) — slash commands `/prompts:megalens-review`, `/prompts:megalens-status`, `/prompts:megalens-result`.
   - **Local Codex Plugin + Marketplace entry** (`~/.codex/plugins/megalens/` + `~/.agents/plugins/marketplace.json`) — discoverable in `codex /plugins` and the Codex desktop app **Plugins** tab.

Restart Codex (CLI or desktop app) after installing.

## GitHub repository prerequisites (while `APP_PATH_ENABLED = false`)

`npx megalens-mcp setup` signs in your Codex editor MCP config (`~/.codex/config.toml`) only. Because the MegaLens GitHub App runner is disabled behind `APP_PATH_ENABLED = false` until the on-demand server endpoints are live, running `$megalens-review` on a GitHub repository currently uses your repository's **GitHub Actions workflow** and requires:

1. **GitHub CLI authenticated:** `gh auth login`
2. **Dispatch workflow on the repository's default branch:** `.github/workflows/megalens-dispatch.yml` (run `$megalens-review --runner github` to print the workflow template).
3. **Repository secret `MEGALENS_TOKEN`:** set once via `gh secret set MEGALENS_TOKEN`.

> **Zero-copy GitHub first-run status:** Blocked until either (a) the MegaLens GitHub App on-demand endpoints ship (`APP_PATH_ENABLED = true`) or (b) a no-copy GitHub Actions secret provisioning flow ships upstream (see `PLUGIN-NEEDS.md` #12 and #15).

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
3. **Missing setup** — prints the setup URL (`Install the MegaLens GitHub App or add the workflow: https://megalens.ai/app/start`) plus explicit GitHub Actions workflow instructions while `APP_PATH_ENABLED = false`.
   Never falls back silently to a local engine, never pushes commits without your OK, and never prints tokens.

## Codex Desktop App MCP configuration

Codex CLI and the Codex desktop app share `~/.codex/config.toml` (`$CODEX_HOME/config.toml`). Running `npx megalens-mcp setup` configures it via browser sign-in automatically.

For OAuth-based MCP setup instead of browser device token setup, see [`config.desktop.example.toml`](config.desktop.example.toml), or pass `--with-oauth-mcp` to `install-codex.mjs` (TOML-aware lookup; never overwrites an existing `mcp_servers.megalens` entry in any TOML form, including inline tables or quoted keys), then run `codex mcp login megalens`.

## Advanced

- **Project-scoped install (repo skills + repo marketplace):**
  ```sh
  MEGALENS_CODEX_PLUGIN=1 node codex/scripts/install-codex.mjs --project --dir /path/to/repo
  ```
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
