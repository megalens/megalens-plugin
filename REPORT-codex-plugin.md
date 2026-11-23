# Report: MegaLens Codex Plugin (CLI + Desktop App) — Roadmap 9b

Date: 2026-11-23  
Branch: `feat/codex-plugin` (standalone clone `/root/review-input/ws-codex-plugin`)  
Status: Built, verified locally (tests + real `codex-cli 0.170.0` manifest/marketplace/MCP validation), gated OFF by default behind `CODEX_PLUGIN_ENABLED = false`.

---

## 1. What Was Built

Built the Codex equivalent of the MegaLens Claude Code one-command plugin under `codex/`, supporting both **Codex CLI** and the **Codex desktop app** (ChatGPT desktop app) while reusing the existing one-command engine (`scripts/engine.mjs`, `scripts/lib/gh-runner.mjs`, `scripts/lib/wait-loop.mjs`, `scripts/lib/latest-review.mjs`, `scripts/lib/engine-core.mjs`, `scripts/hosts/toml-check.mjs`):

1. **One-command review front end (`codex/scripts/codex-review.mjs`):**
   - Same one-command review flow as `/megalens:review`: starts the review, streams progress lines up to the 20-minute cap, and prints findings inline without exposing internal IDs unless something fails.
   - Same runner order:
     1. GitHub App path remains disabled behind `APP_PATH_ENABLED = false` (re-imported directly from `scripts/lib/gh-runner.mjs`).
     2. Dispatches `.github/workflows/megalens-dispatch.yml` on the repository's default branch when present.
     3. Prints the exact one-line setup URL (`Install the MegaLens GitHub App or add the workflow: https://megalens.ai/app/start`) when the workflow is missing (never silently falls back to a local engine).
     4. Advanced flags (`--runner github|local`, `--base REF --head REF`, `--quiet`, `--no-wait`) pass through only when explicitly typed; `double` stays disabled (`DOUBLE_TIER_ENABLED = false`).
   - Same no-ID `status` and `result` resolution (latest review bookmark + GitHub lookup), with strict upfront validation of explicit review IDs (`rv_...`, `gh:<digits>`, `app:<digits>`).
   - Adapts only MegaLens plugin UX command hints (`/megalens:review` -> `$megalens-review`, `/megalens:status` -> `$megalens-status`, `/megalens:result` -> `$megalens-result`, `restart Claude Code` -> `restart Codex`, bundle hint -> `npx megalens-mcp setup codex`) while keeping model findings verbatim and preserving all secret scrubbing.

2. **Codex Skills + CLI Custom Prompts + Portable Plugin Package + Desktop App MCP Config:**
   - **Codex Skills** (`codex/skills/megalens-{review,status,result}/{SKILL.md,agents/openai.yaml}`): OpenAI's official cross-surface workflow format for Codex CLI (`$megalens-review`, `$megalens-status`, `$megalens-result`) and the Codex desktop app (Skills picker / `@`). Every skill sets `policy.allow_implicit_invocation: false` so Codex never triggers a paid review unprompted.
   - **Codex CLI Custom Prompts** (`codex/prompts/megalens-{review,status,result}.md`): Slash commands (`/prompts:megalens-review [deep]`, `/prompts:megalens-status [review-id]`, `/prompts:megalens-result [review-id]`) for `~/.codex/prompts/` (`$CODEX_HOME/prompts/`), using `$ARGUMENTS` and escaping literal `$` as `$$` per official Codex custom prompts rules.
   - **Portable Codex Plugin Manifest & Local Marketplace** (`codex/plugin.json`, `codex/mcp.json`, `codex/.agents/plugins/marketplace.json`): Follows the official Agent Plugins 1.0.0 schema (`plugin.schema.json` + `mcp.schema.json`) with `extensions["com.openai"]` metadata and a Streamable HTTP MCP definition for `https://megalens.ai/api/mcp?ide=codex` (OAuth).
   - **Codex Desktop App & CLI MCP Config** (`codex/config.desktop.example.toml` + browser sign-in via `npx megalens-mcp setup codex`): Both Codex CLI and the Codex desktop app share `~/.codex/config.toml` (`$CODEX_HOME/config.toml`). Browser sign-in (`npx megalens-mcp setup codex`) writes `[mcp_servers.megalens]` with zero token copy; `--with-oauth-mcp` in `install-codex.mjs` is optional and never overwrites an existing `[mcp_servers.megalens]` block.

3. **2-Line User Install (`codex/README.md` + `codex/scripts/install-codex.mjs`):**
   ```sh
   npx megalens-mcp setup codex
   MEGALENS_CODEX_PLUGIN=1 node codex/scripts/install-codex.mjs
   ```
   *(Once `CODEX_PLUGIN_ENABLED` is flipped to `true` on release, line 2 becomes `node codex/scripts/install-codex.mjs`.)*
   - Safe installer invariants: all-or-nothing validation before writing, symlink refusal, atomic writes preserving file modes, owner-only backups (`0700` dir / `0600` file) outside any repository under `~/.megalens/backups/codex-plugin/`, idempotent re-runs, `--dry-run`, `--global` (default) and `--project` scopes, and zero token writes.

---

## 2. Official Codex Documentation Cited (Checked 2026-11-23)

- **Build & Package Codex / ChatGPT Plugins (portable `plugin.json`, `mcp.json`, `extensions.com.openai`, `.agents/plugins/marketplace.json`, `codex plugin marketplace add`):**  
  https://developers.openai.com/plugins/build/plugins (redirected from https://developers.openai.com/codex/plugins/build)
- **Plugins Overview (Codex CLI `/plugins`, ChatGPT/Codex desktop app Plugins tab, install & cache):**  
  https://learn.chatgpt.com/docs/plugins (redirected from https://developers.openai.com/codex/plugins)
- **Build Skills (`.agents/skills/<name>/SKILL.md`, `agents/openai.yaml`, `policy.allow_implicit_invocation: false`, `$skill` invocation):**  
  https://learn.chatgpt.com/docs/build-skills (redirected from https://developers.openai.com/codex/skills)
- **Custom Prompts (deprecated in favor of skills; `~/.codex/prompts/*.md`, `/prompts:<name>`, `$ARGUMENTS`, `$$` escaping):**  
  https://learn.chatgpt.com/docs/custom-prompts (redirected from https://developers.openai.com/codex/custom-prompts)
- **Model Context Protocol in Codex (`~/.codex/config.toml` shared by Codex CLI, ChatGPT/Codex desktop app, and IDE extension; Streamable HTTP `url`, `bearer_token_env_var`, `startup_timeout_sec`, `tool_timeout_sec`, OAuth `codex mcp login`):**  
  https://learn.chatgpt.com/docs/extend/mcp?surface=cli (redirected from https://developers.openai.com/codex/mcp)
- **ChatGPT / Codex Desktop App:**  
  https://learn.chatgpt.com/docs/app (redirected from https://developers.openai.com/codex/app)

---

## 3. Files Added / Modified

### Added under `codex/`
- `codex/README.md` — 2-line install steps, usage (`$megalens-review`, `/prompts:megalens-review`), runner order, desktop app MCP notes, privacy notice.
- `codex/plugin.json` — Portable Agent Plugins 1.0.0 manifest + `extensions["com.openai"].interface`.
- `codex/mcp.json` — Portable Agent Plugins 1.0.0 MCP manifest (`streamable-http` -> `https://megalens.ai/api/mcp?ide=codex`, OAuth).
- `codex/.agents/plugins/marketplace.json` — Local/repo Codex plugin marketplace catalog.
- `codex/config.desktop.example.toml` — Shared `~/.codex/config.toml` reference snippet for Codex CLI + Codex desktop app (no secret literals).
- `codex/skills/megalens-review/SKILL.md` & `agents/openai.yaml` — Explicit-only one-command review skill.
- `codex/skills/megalens-status/SKILL.md` & `agents/openai.yaml` — Explicit-only review status skill.
- `codex/skills/megalens-result/SKILL.md` & `agents/openai.yaml` — Explicit-only review result skill.
- `codex/prompts/megalens-review.md` — Codex CLI `/prompts:megalens-review` custom slash prompt.
- `codex/prompts/megalens-status.md` — Codex CLI `/prompts:megalens-status` custom slash prompt.
- `codex/prompts/megalens-result.md` — Codex CLI `/prompts:megalens-result` custom slash prompt.
- `codex/scripts/flags.mjs` — `CODEX_PLUGIN_ENABLED = false`, `MEGALENS_CODEX_PLUGIN` env helper, re-exported `APP_PATH_ENABLED`.
- `codex/scripts/codex-review.mjs` — Flag-gated Codex command front end wrapping `scripts/engine.mjs`.
- `codex/scripts/install-codex.mjs` — Flag-gated safe installer for Codex CLI + Codex desktop app.

### Added / Updated in Repo Root
- `tests/codex-plugin.test.mjs` — Unit, CLI subprocess, installer safety, and manifest/spec validation tests.
- `package.json` — Added `tests/codex-plugin.test.mjs` to `npm test`.
- `REPORT-codex-plugin.md` — This report.

*(Zero changes to any existing Claude Code plugin files under `.claude-plugin/`, `commands/`, `scripts/`, `templates/`, or existing test files.)*

---

## 4. Feature Flags (All Default OFF)

| Flag | Location | Default | Effect When OFF | How to Enable |
|---|---|---|---|---|
| `CODEX_PLUGIN_ENABLED` | `codex/scripts/flags.mjs` | `false` | `codex-review.mjs` exits 4 with zero subprocesses; `install-codex.mjs` exits 4 with zero file writes; existing Claude Code plugin behaviour is 100% unchanged. | Set `MEGALENS_CODEX_PLUGIN=1` (testing) or flip `CODEX_PLUGIN_ENABLED = true` in a reviewed release commit on owner GO. |
| `APP_PATH_ENABLED` | `scripts/lib/gh-runner.mjs` (re-exported by `codex/scripts/flags.mjs`) | `false` | GitHub App runner path stays off; auto-pick uses `.github/workflows/megalens-dispatch.yml` or prints `https://megalens.ai/app/start`. | Flip `APP_PATH_ENABLED = true` after on-demand App endpoints are live. |
| `DOUBLE_TIER_ENABLED` | `scripts/lib/engine-core.mjs` | `false` | `double` tier returns unavailable message. | Constant change on owner GO. |
| `BYO_KEY_ENABLED` / `BYO_LOGIN_ENABLED` | `scripts/lib/engine-core.mjs` | `false` | BYO modes disabled. | Constant change on owner GO. |

**Pricing / Money:** No new paid actions or pricing introduced; reviews use the existing MegaLens GitHub workflow / MCP credit & free-review paths (no charge on failures).  
**Privacy:** No customer code is logged or persisted beyond the existing review flow; no tokens or secrets are written by `install-codex.mjs` or printed by `codex-review.mjs`; no tracking pixels.

---

## 5. Tests & Verification

- **Automated test suite (`npm test`):** **191 / 191 passed, 0 failed** (duration ~28.2 s):
  - **175 existing tests** (`collect`, `mcp-server`, `security`, `review2`, `install`, `engine-v2`, `gh-runner`, `one-command`) — all green with zero modifications, proving live Claude Code plugin behaviour is unchanged.
  - **16 new Codex plugin tests** (`tests/codex-plugin.test.mjs`) covering:
    - `CODEX_PLUGIN_ENABLED = false` and `APP_PATH_ENABLED = false` default OFF gating (`codex-review.mjs` executes 0 subprocesses, `install-codex.mjs` writes 0 files/backups, Claude engine unchanged).
    - Auto-pick runner order (dispatches workflow when present while skipping App API calls; prints exact one-line setup URL when workflow missing; never falls back to local engine).
    - `deep` tier dispatch, `--runner app` and `double` tier disabled before any GitHub call.
    - Fake-clock wait loop progress lines, 20-minute cap (`Still running. Run $megalens-result to see it.`), and no-ID `status`/`result` retrieval.
    - Dirty worktree stop, unpushed commit `NEEDS THE USER'S OK` without pushing, malformed/injection review ID rejection before any subprocess call.
    - Codex UX command hint adaptation without mangling model findings, plus secret scrubbing (`MEGALENS_TOKEN`, `ghp_...`).
    - Real Node CLI subprocess checks (default OFF exit 4; `MEGALENS_CODEX_PLUGIN=1 --help` exit 0).
    - Installer (`install-codex.mjs`) global & project scopes, idempotency, zero token writes, `--with-oauth-mcp` TOML merge + preservation of existing `npx megalens-mcp setup codex` config, `marketplace.json` merge preserving other plugins, owner-only `0600` backups outside repo, `--dry-run`, symlink refusal, and all-or-nothing rollback on failure.
    - Static validation of `codex/plugin.json`, `codex/mcp.json`, `codex/.agents/plugins/marketplace.json`, `codex/config.desktop.example.toml`, all `skills/*/SKILL.md` + `agents/openai.yaml` (`allow_implicit_invocation: false`), all `prompts/*.md` (`$ARGUMENTS`, `$$` escaping), and `codex/README.md`.
- **Real `codex-cli 0.170.0` verification (isolated temp `HOME`/`CODEX_HOME`, deleted immediately after):**
  - `codex plugin marketplace add ./codex --json` -> succeeded (`marketplaceName: "megalens"`).
  - `codex plugin list --available --json` -> listed `megalens@megalens` (`version: "0.1.0"`, `installPolicy: "AVAILABLE"`, `authPolicy: "ON_USE"`) and `megalens@personal-megalens` after `install-codex.mjs`.
  - `codex plugin add megalens@personal-megalens --json` -> succeeded (`pluginId: "megalens@personal-megalens"`, `installed: true`, `enabled: true`, `authPolicy: "ON_USE"`).
  - `codex mcp list` -> parsed `[mcp_servers.megalens]` (`url: https://megalens.ai/api/mcp?ide=codex`, `Status: enabled`).

---

## 6. Owner Steps (Before Going Live)

1. **Test locally with flag ON ("OWNER: test codex plugin"):**
   - Run `npx megalens-mcp setup codex` (browser sign-in, no token copy).
   - Run `MEGALENS_CODEX_PLUGIN=1 node codex/scripts/install-codex.mjs` and export `MEGALENS_CODEX_PLUGIN=1`.
   - Restart Codex CLI and the Codex desktop app; verify `$megalens-review`, `/prompts:megalens-review`, `$megalens-status`, `$megalens-result`, and the **Plugins** directory entry (`MegaLens`).
2. **Flip `CODEX_PLUGIN_ENABLED = true`** in `codex/scripts/flags.mjs` (and simplify line 2 of `codex/README.md`) in a reviewed commit once owner test passes.
3. **Optional — Public OpenAI Plugins Directory submission:**
   - Add `./assets/icon.png` and `./assets/logo.png` to `codex/plugin.json` (`extensions["com.openai"].interface.{composerIcon,logo}`) and submit via https://developers.openai.com/plugins/deploy/submission if public ChatGPT/Codex directory distribution is desired.
4. **When GitHub App on-demand endpoints go live:** flipping `APP_PATH_ENABLED = true` in `scripts/lib/gh-runner.mjs` automatically enables the App runner for both Claude Code and Codex plugins in lockstep.

---

## 7. Open Questions

1. **Public OpenAI Plugin Directory vs. Git/CLI distribution:** OpenAI's public directory requires OAuth/remote MCP verification and rejects plugins with local lifecycle hooks. Our `codex/plugin.json` + `codex/mcp.json` intentionally avoid hooks and declare remote Streamable HTTP OAuth so it stays eligible for public submission, while local `codex-review.mjs` handles the GitHub Actions one-command flow. Confirm whether we want to submit to the public directory after owner testing or distribute via the one-command installer (`1c`) + repo marketplace first.
2. **Standalone `codex/` copy / npm distribution:** Right now `codex/scripts/codex-review.mjs` directly imports `../../scripts/engine.mjs` so there is zero drift from the Claude Code plugin. If `codex/` is ever published as a standalone repository or npm package (for `marketplace.json` `"source": "npm"`), `scripts/` will need to be bundled or published as a shared package.
3. **Host-aware reviewer (OpenAI-on-OpenAI):** Note per `ROADMAP-CODERABBIT-PARITY.md`: Codex users running the GitHub Actions engine currently get the engine's configured reviewer; once the host-aware fallback reviewer (Neon/Opus for OpenAI hosts) lands in `engine-v2`, `codex-review.mjs` can pass a host hint if desired.
