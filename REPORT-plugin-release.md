# MegaLens plugin release report

## Sources

| Host | Source branch | Source commit |
| --- | --- | --- |
| Claude Code | `feat/plugin-app-path`, starting point of `release/v0.2.0` | `8779732c4be17f3608a36ebfe2e34dbef326ea6c` |
| Codex | `ws-codex-plugin`, `feat/codex-plugin` | `efbea85383438072dec684713ed7c60ed17c16ac` |
| Cursor | `ws-cursor`, `feat/plugin-gh-runner` | `bb70d33dce30f81503d3243fba5c2b44e6407905` |
| GitHub Copilot, OpenCode and Antigravity | `ws-more-hosts`, `feat/more-hosts` | `0b6105dcadc61322ef26673d978cdd3a04f26865` |

All three input branches were fetched locally without tags. The octopus merge stopped on shared conflicts. The checkout then merged Codex with `--no-commit` and applied the Cursor and more-hosts changes from their merge bases. The resulting staged tree contains all three inputs. `MERGE_HEAD` records Codex and the Cursor and more-hosts inputs are recorded above and in local `release-input/*` refs. The release branch still points to the owner-tested Claude Code starting commit.

## Conflict resolution and layout

- `scripts/engine.mjs` and `scripts/lib/gh-runner.mjs` retain the Claude Code App path, including its wait and resume behavior. The Actions fallback also carries Cursor's per-review approval and organization secret checks and Codex's retry artifact retrieval.
- `scripts/lib/engine-core.mjs` keeps `--no-wait` and adds `--allow-gateway`. The shared tests cover the older workflow format as well as approval on the new workflow.
- `commands/` keeps the Claude Code review, status and result paths and brings over the more-hosts guard against automatic paid retries. Codex and Cursor keep their reviewed standalone runtimes and commands.
- `claude/` is a self-contained Claude Code plugin. The root Claude plugin paths still work for existing local installs. `codex/` holds the Codex CLI and desktop package. `cursor/` holds the Cursor package and archive inputs.
- `copilot/`, `opencode/` and `antigravity/` each provide a preview setup command using the reviewed browser login and config writer under `scripts/hosts/`. The generic rollout gates stay at their source defaults. Codex's preview command installs the package and invokes native OAuth in the same terminal command. Its GitHub App path remains gated off.
- `README.md` has one install command per host. `CHANGELOG.md` records the single plugin release. The former host README details are in the Claude Code, Codex and Cursor guides. The install examples preserve the exact command and path spelling.
- `package.json` keeps the existing root package name and Codex installer binary. `npm test` checks generated files and runs every suite.

## Pins

The source branches still carried older dispatch templates. The local `ws-action-131` repository resolves the annotated `v1.3.0` tag to the commit in `release/pins.json`. Its `src/engine.js` pins engine `0.1.5`. The working templates use that pair.

| File | Pin values |
| --- | --- |
| `release/pins.json` | Editable source for the Action commit and tag, engine version, checkout and artifact action commits and tags, and plugin version |
| `templates/megalens-dispatch.yml` | Generated Action and engine pins for the root entry point |
| `claude/templates/megalens-dispatch.yml` | Generated copy for the standalone Claude Code plugin |
| `codex/runtime/templates/megalens-dispatch.yml` | Generated copy for the standalone Codex runtime |
| `cursor/templates/megalens-dispatch.yml` | Generated copy for the standalone Cursor package |
| `package.json`, `.claude-plugin/plugin.json`, `claude/.claude-plugin/plugin.json`, `codex/.codex-plugin/plugin.json`, `.cursor-plugin/marketplace.json`, `cursor/.cursor-plugin/plugin.json`, `cursor/package.json` | Plugin release version |
| `CHANGELOG.md` | Release version heading |

To switch to Action v1.3.1 and engine 0.1.8, update the Action tag and commit and the engine version in `release/pins.json`, then run `npm run sync:release`. The Claude Code local engine install command reads the same engine pin. The MCP servers read their host manifests for the plugin version. The older pins in `REPORT-ONE-COMMAND.md`, `REPORT-CURSOR.md` and `REPORT-codex-plugin.md` describe historical test inputs.

## Verification

- `npm test` passed all 297 tests across all six hosts, including isolated Claude Code packaging, Cursor archive installation, mocked GitHub Actions runs, and preview setup checks.
- Verification used a disposable profile with offline npm. A test-only Git wrapper built scratch repository history with `git commit-tree` and `git update-ref`. Test fixtures that used files named `.env` now exercise the same exclusion paths with other synthetic filenames. The pure filename tests still cover `.env` patterns.
- All four generated workflow copies parsed as YAML and matched the expected pins. Claude Code's local plugin validator passed and reported a directory listing warning for the missing icon.
- Published marketplace installation, live sign in, live reviews and upstream settlement were outside this local verification. The App deferred settlement release gate is recorded in `PLUGIN-NEEDS.md`.
