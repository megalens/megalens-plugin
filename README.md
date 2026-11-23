# MegaLens for Claude Code

Independent code review for your changes inside Claude Code. One command starts the review, waits while it runs, and shows the findings inline in the same answer.

## Quick start (2 steps)

You need Node 18+ and `git`, plus either:

* **MegaLens GitHub App (easiest):** install the App on your repository at https://megalens.ai/app/start and set your MegaLens sign-in token (`MEGALENS_TOKEN`) in your environment. (`gh auth login` is optional; when installed, it also lets MegaLens detect your open pull request automatically.)
* **Or your own GitHub Actions runner:** set up the MegaLens workflow on your default branch with the GitHub CLI (`gh auth login`). [Workflow setup](#running-on-your-own-github-actions-runner)

1. **Install the plugin.**

   ```sh
   claude --plugin-dir /path/to/megalens-claude-plugin
   ```

2. **Run a review.**

   ```text
   /megalens:review
   ```

If the MegaLens GitHub App is installed on this repository, MegaLens starts the review on its review machine, shows short progress lines while it runs, and prints the findings right in the same answer. If the App is not installed, MegaLens uses your GitHub Actions workflow when present. If neither is set up, the command prints one line:

```text
Install the MegaLens GitHub App or add the workflow: https://megalens.ai/app/start
```

Standard is the default tier. For a deeper pass, run `/megalens:review deep`.

If you stop waiting or reach the 20 minute limit, MegaLens prints `Still running. Run /megalens:result to see it.` You can also run `/megalens:status` to check progress, or run `/megalens:review` again (MegaLens reuses your in-flight review for the same commit and tier instead of charging twice). Findings from GitHub App reviews stay available for 24 hours.

MegaLens asks before pushing commits, reports partial or failed reviews as incomplete, and keeps tokens out of the output.

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

The tests cover GitHub App on-demand reviews, runner selection, out-of-credits and failure handling, lost-reply deduplication, status and result without an ID, the 20 minute wait limit, the installer, the collector, the local MCP server, the engine front end and the GitHub Actions runner. They use temporary repositories and simulated responses, with no network or model calls.

---

## Advanced

### Flags and explicit review ids

* `/megalens:review --runner app|github|local` selects the MegaLens GitHub App, your GitHub Actions runner, or the local engine.
* `/megalens:review --base REF --head REF` reviews an explicit commit range (uses the GitHub Actions workflow or `--runner local`).
* `/megalens:review --quiet` enables the engine's optional filter (off by default).
* `/megalens:review --no-wait` starts the review without waiting in the same command.
* `/megalens:status <id>` and `/megalens:result <id>` accept App job IDs (`app:<uuid>`), workflow IDs (`gh:<run-id>`), and local review IDs (`rv_<id>`).

### MegaLens GitHub App details

When `MEGALENS_TOKEN` is set, `/megalens:review` checks `GET /api/github-app/status?repo=<owner/name>`. If the App is installed, linked to your account, active, and its setup notice is accepted, MegaLens submits the review to `POST /api/github-app/review-now` (with your open non-draft pull request number when `gh` detects one on `HEAD`, or your pushed commit SHA otherwise) and polls `GET /api/github-app/review-now/<id>` until completion.

* Only pushed commits are reviewed; uncommitted changes stop before anything starts.
* One charge per review: re-running `/megalens:review` for the same commit and tier (or retrying after a lost network reply) reuses the in-flight or retained job.
* Results stay stored on MegaLens for 24 hours.
* `MEGALENS_API_URL` (optional, must be `https://` or loopback `http://127.0.0.1|localhost`) overrides the MegaLens API origin for testing.

### Running on your own GitHub Actions runner

1. Copy `templates/megalens-dispatch.yml` to `.github/workflows/megalens-dispatch.yml` on your repository's **default branch** and push it.
2. Run `gh secret set MEGALENS_TOKEN` to store your MegaLens token as a repository secret. The plugin never reads or prints the value.
3. Run `/megalens:review` or `/megalens:review deep`.

`templates/megalens-dispatch.yml` pins `megalens/review-action@950eb5f1eeff21008fcf585587b88fc83546cdcf` (tag `v1.2.0`, engine `megalens-review` `0.1.3`) in all three jobs (`create`, `review`, `publish`). Only commits on GitHub are reviewed; uncommitted changes are never silently skipped.

### Local engine on Linux

On Linux with bubblewrap, use `/megalens:review --runner local` to review uncommitted changes. Install `megalens-review` with `npm install -g megalens-review@0.1.3`, make it available on `PATH` or through `MEGALENS_REVIEW_BIN`, and set `MEGALENS_TOKEN` in your shell. Run `node scripts/engine.mjs install` once to install the pinned Codex CLI and verify its hash. To check it again, run `node scripts/engine.mjs verify`. The engine refuses to run as root. OpenAI key and login modes are disabled in this build. [Engine requirements](PLUGIN-NEEDS.md)

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
