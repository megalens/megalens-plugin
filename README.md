# MegaLens for Claude Code

Independent code review for your changes inside Claude Code. One command starts the review, waits while it runs, and shows the findings inline in the same answer.

## Quick start (2 steps)

Needs Node 18+, `git`, and the GitHub CLI (`gh auth login`). If MegaLens is not installed on your repository yet, install the MegaLens GitHub App once at https://megalens.ai/app/start (no workflow file or token needed).

1. **Install the plugin:**

   ```sh
   claude --plugin-dir /path/to/megalens-claude-plugin
   ```

2. **Run a review:**

   ```text
   /megalens:review
   ```

That's it. MegaLens picks the runner automatically (our review machine via the GitHub App when installed for your repository, otherwise your own GitHub Actions runner if its workflow is present), starts the review, prints short progress lines (`Review started`, `Running on GitHub...`, `About 2 minutes so far`), and prints the findings inline when it finishes.

- **Deeper pass:** run `/megalens:review deep` (Standard is the default).
- **Stopped early or hit the 20-minute wait limit?** MegaLens prints `Still running. Run /megalens:result to see it.` Run `/megalens:result` later to see the latest review for this repository, or `/megalens:status` to check progress.
- **Safety:** MegaLens never pushes your commits without asking, never calls a partial or failed review clean, and never prints tokens.

## `.megalens/rules`

Add an optional `.megalens/rules` file in your repository with one plain-English review rule per line (up to 8 KB). Example:

```text
# Rules for this repo
Money is stored as integer cents; flag any float arithmetic on prices.
Every route under src/api/ must check the session before reading the body.
Ignore anything under legacy/; it is scheduled for deletion.
Do not suggest new dependencies.
```

Rules guide the review; never put secrets in this file.

## Privacy

Read https://megalens.ai/privacy before reviewing code you do not own or that is under NDA. Finding text comes from a model: check each finding against your code before acting on it.

## Tests

```sh
npm test
```

The tests cover runner auto-pick, the wait loop (with a fake clock), no-id status/result, the 20-minute wait cap, the installer, the collector, the local MCP server, the engine front end and the GitHub runner. They use temporary repositories and fakes, so they make no network or model calls.

---

## Advanced

Nothing below is required for the main `/megalens:review` path above.

### Flags and explicit review ids

- `/megalens:review --runner app|github|local` forces a specific runner instead of auto-picking.
- `/megalens:review --base REF --head REF` reviews an explicit commit range.
- `/megalens:review --quiet` enables the engine's optional filter (off by default).
- `/megalens:review --no-wait` starts the review without waiting in the same command.
- `/megalens:status <id>` and `/megalens:result <id>` look up a specific review (`app:<check-id>`, `gh:<run-id>`, or `rv_<id>`) instead of the latest review for this repository.

### Running on your own GitHub Actions runner

If you prefer reviews to run inside your own GitHub Actions runner instead of the MegaLens GitHub App:

1. Copy `templates/megalens-dispatch.yml` to `.github/workflows/megalens-dispatch.yml` on your repository's **default branch** and push it.
2. Store your MegaLens token as a repository secret: `gh secret set MEGALENS_TOKEN` (the plugin never reads or prints the value).
3. Run `/megalens:review` (or `/megalens:review deep`). When the GitHub App is not installed on the repo, MegaLens picks this workflow automatically.

`templates/megalens-dispatch.yml` pins `megalens/review-action@950eb5f1eeff21008fcf585587b88fc83546cdcf` (tag `v1.2.0`, engine `megalens-review` `0.1.3`) in all three jobs (`create`, `review`, `publish`). Only commits on GitHub are reviewed; uncommitted changes are never silently skipped.

### Local engine on Linux

On Linux with bubblewrap, if `megalens-review` (`npm install -g megalens-review@0.1.3`) is on `PATH` (or `MEGALENS_REVIEW_BIN`) and `MEGALENS_TOKEN` is set in your shell, `/megalens:review` can run locally over uncommitted changes as well. Run `node scripts/engine.mjs install` once to install and hash-verify the pinned Codex CLI (`node scripts/engine.mjs verify` re-checks it). The engine refuses to run as root, and BYO OpenAI key / login modes are switched off in this build. See `PLUGIN-NEEDS.md`.

**Later:** a Double tier (Claude reviews first, then the engine uses that review as context) is built behind a constant and not available at launch; `/megalens:review double` answers "The Double tier is not available yet; use standard or deep." Its steps are kept in `docs/double-tier-later.md`.

### Bundle MCP route (`/megalens:megalens-review`)

For setups without a GitHub repository or engine, the plugin also ships the legacy MCP bundle route:

| | `/megalens:megalens-review` (token) | `/megalens:megalens-review-remote` (OAuth fallback) |
|---|---|---|
| Needs | `MEGALENS_TOKEN` in the environment | OAuth sign-in (`/mcp`, pick `megalens`) |
| Who sends the code | local stdio tool (`megalens-local`, `scripts/mcp-server.mjs`) | Claude copies the bundle into the tool call |
| Bundle limit | 200 KB default, 700 KB max (`MEGALENS_MAX_BYTES`) | 90 KB |

Environment variables for `scripts/mcp-server.mjs`: `MEGALENS_TOKEN`, `MEGALENS_URL` (default `https://megalens.ai/api/mcp?ide=claude-code`), `MEGALENS_MAX_BYTES`, `MEGALENS_AUDIT_LOG`, `MEGALENS_REQUEST_TIMEOUT_MS` (default 90 s), `MEGALENS_POLL_TIMEOUT_MS` (default 25 min), `MEGALENS_PROJECT_DIR`.

Preview what the collector would send with `node scripts/collect.mjs --max-bytes 200000`. Lockfiles, binaries, generated/vendored files, credential-named files, symlinks outside the repo, and secret-shaped content are skipped or redacted (`scripts/lib/safety.mjs`).

`.mcp.json` declares both `megalens-local` (token) and `megalens` (OAuth). Copy `.mcp.bearer.example.json` over `.mcp.json` only for headless bearer auth on the remote server (with `MCP_CONNECTION_NONBLOCKING=false` for `claude -p`).

### Other hosts: Codex, Cursor, GitHub Copilot

The local MCP bundle tool (`scripts/mcp-server.mjs`) can also be installed into Codex, Cursor, or GitHub Copilot:

```sh
node scripts/install.mjs --host codex|cursor|copilot [--project|--global] [--dir REPO] [--dry-run]
```

The installer merges into existing configs, writes owner-only backups under `~/.megalens/backups/<host>/<time>/`, validates before writing, refuses symlinks, and never writes your token unless `--token-file FILE` (mode 0600) is passed.
