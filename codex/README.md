# MegaLens for Codex (CLI + Desktop App)

Independent multi-company code review inside **Codex CLI** and the **Codex desktop app** (ChatGPT desktop app). One command starts the review, waits up to 20 minutes while it runs, and shows findings inline.

## Install (2 lines)

```sh
npx megalens-mcp setup codex
MEGALENS_CODEX_PLUGIN=1 node codex/scripts/install-codex.mjs
```

> **Feature flag (default OFF):** Until release, both the installer and command runner are gated behind `CODEX_PLUGIN_ENABLED = false` (`MEGALENS_CODEX_PLUGIN=1` opts in; export `MEGALENS_CODEX_PLUGIN=1` in your shell while testing). Once flipped to `true` on release, line 2 is simply `node codex/scripts/install-codex.mjs`.

What those two lines do:
1. **`npx megalens-mcp setup codex`** opens browser sign-in (no token copy) and configures `[mcp_servers.megalens]` in `~/.codex/config.toml` — shared automatically by **Codex CLI**, the **Codex desktop app**, and the Codex IDE extension.
2. **`install-codex.mjs`** installs:
   - **Codex Skills** (`~/.agents/skills/megalens-{review,status,result}/`, explicit-invocation only via `agents/openai.yaml`) — works in Codex CLI (`$megalens-review`) and Codex desktop app (Skills / `@`).
   - **Codex CLI Custom Prompts** (`~/.codex/prompts/megalens-{review,status,result}.md`) — slash commands `/prompts:megalens-review`, `/prompts:megalens-status`, `/prompts:megalens-result`.
   - **Local Codex Plugin + Marketplace entry** (`~/.codex/plugins/megalens/` + `~/.agents/plugins/marketplace.json`) — discoverable in `codex /plugins` and the Codex desktop app **Plugins** tab.

Restart Codex (CLI or desktop app) after installing.

## Run a review (one command)

- **Codex CLI or Desktop App (Skill — recommended):**
  ```text
  $megalens-review
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
3. **Missing setup** — prints one line:
   ```text
   Install the MegaLens GitHub App or add the workflow: https://megalens.ai/app/start
   ```
   Never falls back silently to a local engine, never pushes commits without your OK, and never prints tokens.

## Codex Desktop App MCP configuration

Codex CLI and the Codex desktop app share `~/.codex/config.toml` (`$CODEX_HOME/config.toml`). Running `npx megalens-mcp setup codex` configures it via browser sign-in automatically.

For OAuth-based MCP setup instead of browser device token setup, see [`config.desktop.example.toml`](config.desktop.example.toml), or pass `--with-oauth-mcp` to `install-codex.mjs` (never overwrites an existing `[mcp_servers.megalens]` block).

## Advanced

- **Project-scoped install (repo skills + repo marketplace):**
  ```sh
  MEGALENS_CODEX_PLUGIN=1 node codex/scripts/install-codex.mjs --project --dir /path/to/repo
  ```
- **Native Codex CLI marketplace install:**
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
