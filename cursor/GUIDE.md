# MegaLens for Cursor

Independent multi-model code review inside Cursor, running on **your own GitHub Actions runner** (Windows, macOS, Linux). Review your current branch or pull request, view the latest review result, and copy a ready-to-paste fix prompt for any finding.

## Privacy

The review runs on your own GitHub Actions runner. The diff and code excerpts pass through the MegaLens gateway to OpenAI. MegaLens does not keep your code; it passes through our gateway to the AI provider for the review and is not stored. GitHub stores the findings as a workflow artifact.

Read https://megalens.ai/privacy before sending code you do not own or that is under NDA.

## Commands

| Command | What it does | Credits |
|---|---|---|
| `/megalens-review [standard\|deep]` | Starts a review of your current branch or open PR on your GitHub Actions runner after you approve the data transfer. Accepts `--pr <number>` or `--base REF --head REF`. | Standard: 1 · Deep: 8 |
| `/megalens-status [gh:<id>]` | Shows `queued`, `running`, `done`, or `failed` and the GitHub Actions run URL (omit the id for the latest run). | 0 |
| `/megalens-result [gh:<id>]` | Downloads and displays the latest review result (or a specific `gh:<id>`) with numbered findings (`1`, `2`, ...). | 0 |
| `/megalens-fix-prompt [<n>\|--all]` | Shows a copyable fix prompt from the latest review of your current commit. Use `--id gh:<id>` to select a specific run. | 0 |
| `/megalens-login` | Checks MegaLens sign-in, GitHub CLI (`gh`) login, and current repository GitHub Actions runner readiness (workflow + secret name check). | 0 |

Request a MegaLens review and approve the transfer before it starts. In the terminal, pass `--allow-gateway` to the `review` command to approve the transfer for that run.

## Set up the GitHub Actions runner

1. Install the [GitHub CLI](https://cli.github.com) and sign in through your browser.

   ```sh
   gh auth login --hostname github.com --git-protocol https --web --scopes workflow
   ```

2. If the repository needs a `MEGALENS_TOKEN` secret, run this from your repository with Node.js 20 or later.

   ```sh
   npx megalens-review init
   ```

   Sign in to MegaLens in your browser and confirm your account in the terminal. The setup command sends the token to `gh` on stdin to set the `MEGALENS_TOKEN` repository secret without asking you to paste it. Decline the separate pull request for automatic PR reviews. The token is already saved by then.

3. Add `templates/megalens-dispatch.yml` as `.github/workflows/megalens-dispatch.yml` on your repository's **default branch** and push it. If the file is missing, `/megalens-review` prints the template. Run `/megalens-login` to check that the repository is ready, then run `/megalens-review` to dispatch this workflow.

If your CLI version lacks `init` or browser setup is unavailable, create an Action token and enter it at the private terminal prompt from `gh secret set MEGALENS_TOKEN`. [MegaLens MCP settings](https://megalens.ai/app/settings/mcp)

### Connect hosted MCP in Cursor

For hosted MCP, open **Customize** in Cursor, find **megalens**, and click **Connect** to sign in through your browser. The optional `node scripts/cursor-cli.mjs login` command uses your OS credential store for its hosted MCP session.

## Install

### Option 1: Cursor Marketplace (once listed)

1. Open **Customize** in Cursor's sidebar (or browse https://cursor.com/marketplace).
2. Search for **MegaLens** and click **Install** (choose user or project scope).
3. Follow the [runner setup steps](#set-up-the-github-actions-runner) for the repository you want to review.

### Option 2: Install the full plugin from an archive

The archive configures both MCP servers and includes all five commands, the rule, the skill, and the workflow template. Install it with Node.js 18 or later on macOS, Windows, or Linux.

1. Extract the archive in an empty folder.
2. Run the installer from that folder.

```sh
tar -xzf megalens-cursor-plugin-*.tgz
node package/scripts/cursor-cli.mjs install --local-plugin
```

The installer copies the plugin into `~/.cursor/plugins/local/megalens`. Add `--dry-run` to preview file changes. If the installer replaces a file, it saves a backup under `~/.megalens/backups/cursor-plugin/`.

Restart Cursor or run **Developer: Reload Window**. Open **Customize** and check that **MegaLens** and its components appear.

To build the archive from a checkout, run `npm pack ./cursor --ignore-scripts` from the repository root. To install directly from the checkout, run `node cursor/scripts/cursor-cli.mjs install --local-plugin`.

### Option 3: Standalone MCP + commands + rule install into a project

If you prefer explicit `.cursor/mcp.json`, `.cursor/commands/`, and `.cursor/rules/megalens.mdc` files inside a repository without loading a local plugin:

```sh
node cursor/scripts/cursor-cli.mjs install --project --dir /path/to/your-repo
```

Add `--dry-run` to preview changes first, or `--global` to install into `~/.cursor/`. Existing files are merged safely and backed up outside your repo under `~/.megalens/backups/cursor-plugin/` (mode `0600`).

### Option 4: Team Marketplace (Teams & Enterprise plans)

1. Open **Cursor Dashboard → Plugins & MCPs → Team Marketplaces → Add Marketplace**.
2. Choose **Import from Repo** and paste the published Git repository URL.
3. The repository's `.cursor-plugin/marketplace.json` points to the self-contained `cursor` plugin package.

### Option 5: Hosted MCP server sign-in link (hosted MCP server only)

This link registers the hosted MCP server only. Use Option 1 or Option 2 for the full plugin.

To register only the hosted MegaLens OAuth MCP server (`megalens`) for browser sign-in:

- [Add MegaLens Hosted MCP to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=megalens&config=eyJ1cmwiOiJodHRwczovL21lZ2FsZW5zLmFpL2FwaS9tY3A%2FaWRlPWN1cnNvciJ9)

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=megalens&config=eyJ1cmwiOiJodHRwczovL21lZ2FsZW5zLmFpL2FwaS9tY3A%2FaWRlPWN1cnNvciJ9
```

To print a single-server MCP link for the local `megalens-runner` stdio server pointing at an existing local checkout (still MCP server only — no commands, rule, or skill), run:

```sh
node cursor/scripts/cursor-cli.mjs deeplink --local
```

## Example workflow

```text
> /megalens-review standard
The diff and code excerpts pass through the MegaLens gateway to OpenAI. MegaLens does not keep your code; it passes through our gateway to the AI provider for the review and is not stored. Do you approve that transfer for this review?
> Yes
Review of 71f8628..b326c97 in acme/widget, tier standard, runs on your GitHub runner.
Review started on GitHub: gh:44867820388
Run: https://github.com/acme/widget/actions/runs/44867820388
A standard review usually takes a few minutes. Check with /megalens-status gh:44867820388, then fetch with /megalens-result gh:44867820388. Nothing has been reviewed yet.

> /megalens-result
## MegaLens standard review: complete

### Strong findings (1)
- **P1** `src/total.js:3`: Order total adds price and quantity instead of multiplying
  - Problem: unitPriceCents + quantity returns 203 instead of 600 for 3 x 200 cents.

### Finding numbers (for `/megalens-fix-prompt <number> --id gh:44867820388`)
  1. [P1] `src/total.js:3` — Order total adds price and quantity instead of multiplying

> /megalens-fix-prompt 1 --id gh:44867820388
### Fix prompt — P1 `src/total.js:3`: Order total adds price and quantity instead of multiplying

```text
Fix this P1 issue in src/total.js:3:
What is wrong: Order total adds price and quantity instead of multiplying
Why: unitPriceCents + quantity returns 203 instead of 600 for 3 x 200 cents.
Expected behaviour: Verify the bug against the surrounding code and handle this case cleanly without breaking callers.
Source review: gh:44867820388 (https://github.com/acme/widget/actions/runs/44867820388)
Change only what is needed, keep the tests passing, and add a test.
```
```

## Safety & Verdict Guarantees

- **Uncommitted / unpushed commits:** Only commits on GitHub are reviewed on the GitHub runner path. If your latest commit is not pushed, `/megalens-review` stops and asks before pushing; it never pushes on its own.
- **PR auto-detection:** Automatically detects open PRs on the current branch using checkout context. Lookup errors stop loudly instead of silently falling back to the default branch. Cross-repository fork PRs are refused by default per the MegaLens GitHub Action fork policy.
- **Honest verdicts:** `PARTIAL`, `FAILED`, `CANCELLED`, and `NOT COMPLETED` reviews are flagged in the first sentence and never described as clean or "no issues".
- **No secret leaks:** Credential-shaped text is scrubbed from rendered results, numbered finding lists, fix-prompt choosers, fix prompts, and local caches. OAuth tokens are never written to plaintext files on disk. The plugin never asks for tokens in chat.

## Tests

From the repository root:

```sh
npm test
```

All tests run offline with mocked `gh`/`git` binaries, mocked OS keychain commands, and loopback HTTP mocks (no external network calls).
