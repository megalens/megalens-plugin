# MegaLens for Claude Code

This plugin sends your current git change to MegaLens, which has models from different companies review it. The standard panel currently uses models from Anthropic, Google and OpenAI. A script collects the diff, the changed files and some related code, so the model does not choose what to send. The bundle is 200 KB by default and 700 KB at most.

Claude writes its own review first. The result then shows what the panel raised that Claude's review did not.

## Install

From this folder, without a marketplace:

    claude --plugin-dir /path/to/megalens-claude-plugin

Needs Node 18+ and git. The plugin adds two commands and two MCP servers:

| | `/megalens:megalens-review` (recommended) | `/megalens:megalens-review-remote` (fallback) |
|---|---|---|
| Needs | `MEGALENS_TOKEN` in the environment | OAuth sign-in (`/mcp`, pick `megalens`) |
| Who sends the code | a local tool (`megalens-local`, `scripts/mcp-server.mjs`) | Claude copies the bundle into the tool call |
| Bundle limit | 200 KB default, 700 KB maximum | 90 KB |

Set the token before starting Claude Code: `export MEGALENS_TOKEN=...`, then restart. Never commit it. If it is missing, the local tool says so and points to the fallback.

**About the fallback.** Claude has to retype the whole bundle into the `megalens_debate` call. Nothing checks that the copy matches what the collector produced, so a review can rest on code that differs from yours. Use a token when you can.

### Why both servers are declared

`.mcp.json` declares `megalens-local` (stdio, the review tool) and `megalens` (remote, OAuth). The local server can only reach MegaLens with a bearer token. The remote server is the only route for OAuth users, and it also has `megalens_status`, `megalens_history` and `megalens_scope`. If you only use a token you can delete the `megalens` entry. If you only use OAuth, `megalens-local` does nothing except report that no token is set.

**Paid runs you did not ask for.** The remote `megalens` server sends its own usage instructions to the host. They tell the model to offer a MegaLens check after it finishes a change, and to run `megalens_debate` itself if you already agreed to automatic checks. A run costs credits. To avoid this, do not agree to automatic checks while that server is loaded, or delete the `megalens` entry from `.mcp.json`. The local server sends no usage instructions, and its tool description tells the model to call it only for `/megalens:megalens-review` or an explicit MegaLens request.

### Environment variables read by the local server

1. `MEGALENS_TOKEN`: the bearer token.
2. `MEGALENS_URL`: default `https://megalens.ai/api/mcp?ide=claude-code`. Only https is accepted, or http to `127.0.0.1`, `localhost` or `::1`.
3. `MEGALENS_MAX_BYTES`: default bundle limit in bytes, 200000 if unset, 700000 at most.
4. `MEGALENS_AUDIT_LOG`: path of a JSONL file. After a review finishes, the tool appends one record with the bundle sha256, bundle and request sizes, run id and budget.
5. `MEGALENS_REQUEST_TIMEOUT_MS` (default 90 s per request) and `MEGALENS_POLL_TIMEOUT_MS` (default 25 min).
6. `MEGALENS_PROJECT_DIR`: the folder to review, for hosts that do not start the server in your project.

### Token for the remote server too (CI, headless)

Copy `.mcp.bearer.example.json` over `.mcp.json` only if you want the remote server on a bearer header as well. A static header is never replaced by OAuth, so a rejected token fails the connection, and Claude Code may cache that as "needs auth" for a while. For `claude -p` also set `MCP_CONNECTION_NONBLOCKING=false`, otherwise the first turn can start before the servers have connected.

## Other hosts: Codex, Cursor, GitHub Copilot

Codex was tested live on 17 November 2026. The Cursor and GitHub Copilot configs follow those products' documentation and have not been tested live.

The same local tool (`scripts/mcp-server.mjs`, tool `megalens_review_change`) is used in every host. Only the packaging differs. Keep this folder where it is after installing, because the configs point at its absolute path. Needs Node 18+, git and a MegaLens token in `MEGALENS_TOKEN`.

    node scripts/install.mjs --host codex|cursor|copilot [--project|--global] [--dir REPO] [--dry-run]

`--project` (default) writes into the repo given by `--dir` (default: the current folder). `--global` writes into your home folder. The installer:

1. merges into existing files and keeps your other servers;
2. saves a copy of every file it changes under `~/.megalens/backups/<host>/<time>/`, owner-only and never inside your repo, and prints the path;
3. checks every file it will write before writing any of them, and writes nothing if one fails;
4. refuses to read or write through symlinks (a symlinked `AGENTS.md` is skipped);
5. for Codex, checks that the result is valid TOML with no duplicate `megalens-local` entry;
6. leaves a file unchanged if it already has the right content, and prints every file it touched.

It does not write your token. The configs only name the variable, or ask for it. `--token-file FILE` (first line is the token) is the exception: it copies the token into the config files with mode 600. Do not commit them. If a JSON file you already had contained comments, they are dropped from the new file and the backup keeps them. Restart the host after installing.

The local tool refuses to collect when the project folder is your home folder or `/`, when it is not inside a git repository, or when the repository's top level is your home folder. Set `MEGALENS_ALLOW_HOME=1` only if you keep your home folder in git. It also refuses when `MEGALENS_PROJECT_DIR` arrives unexpanded (for example `${workspaceFolder}`).

Cursor and VS Code may not start the server in your project folder, so project installs set `MEGALENS_PROJECT_DIR` to the workspace. Prefer `--project` for them, and confirm the review is of the repository you meant.

### Codex (CLI and IDE extension)

1. Install: `node scripts/install.mjs --host codex --global` adds a block to `~/.codex/config.toml`, the skill `~/.agents/skills/megalens-review/` and the older style prompt `~/.codex/prompts/megalens-review.md`. With `--project` it writes `.codex/config.toml`, `.agents/skills/megalens-review/` and a MegaLens section in `AGENTS.md`.
2. Trust the project (needed for `--project`): Codex ignores a project's `.codex/config.toml`, and so the MegaLens tool, until you trust the folder. Approve the trust prompt, or run `codex exec --trust` once there. Without it Codex says "Untrusted project-local configuration is disabled" and the tool is missing.
3. Token: `export MEGALENS_TOKEN=...` before starting Codex. The config uses `env_vars = ["MEGALENS_TOKEN"]`, which forwards the variable by name.
4. Run: type `$megalens-review` (or `/skills`), optionally naming a ref, `A..B` or `--staged`. Older Codex: `/prompts:megalens-review`.
5. Approvals: Codex asks before calling the tool unless your approval mode allows it. The tool needs network access to megalens.ai and read access to the repo. The installer sets `tool_timeout_sec = 1800`, because the default of 60 seconds would cut a review off.
6. The skill sets `allow_implicit_invocation: false`. That stops Codex from choosing the skill by itself. It does not control tool approval, which is a separate Codex setting.
7. Codex marks custom prompts as deprecated in favour of skills. Use the skill, and the prompt only on older versions.
8. Docs: https://learn.chatgpt.com/docs/extend/mcp?surface=cli, https://learn.chatgpt.com/docs/build-skills, https://learn.chatgpt.com/docs/custom-prompts

### Cursor

1. Install: `node scripts/install.mjs --host cursor --project` writes `.cursor/mcp.json`, the command `.cursor/commands/megalens-review.md` and the rule `.cursor/rules/megalens-review.mdc` (not always on). `--global` writes `~/.cursor/mcp.json` and `~/.cursor/commands/`.
2. Token: `export MEGALENS_TOKEN=...` and start Cursor from that shell. The config uses `${env:MEGALENS_TOKEN}`.
3. Run: type `/megalens-review` in Agent chat, or mention `@megalens-review`.
4. Approvals: by default Cursor asks before running an MCP tool. What happens depends on your Run Mode.
5. Docs: https://cursor.com/docs/mcp, https://cursor.com/docs/context/rules, https://cursor.com/docs/agent/chat/commands. Custom commands are only mentioned in passing in the last one, so check that `/megalens-review` shows up when you type `/`. The rule can be used either way.

### GitHub Copilot (VS Code and Copilot CLI)

1. Install: `node scripts/install.mjs --host copilot --project` writes `.vscode/mcp.json` (key `servers`, token asked through a hidden `promptString` input, nothing stored in the file), the prompt `.github/prompts/megalens-review.prompt.md`, and `.github/mcp.json` for Copilot CLI. `--global` writes only the CLI file `~/.copilot/mcp-config.json`. The prompt has no `tools:` line, because the VS Code docs say that line limits which tools the prompt can use.
2. VS Code: per the current docs, prompt files run only in the Local harness in the Chat view, so select Local before typing `/megalens-review`. The docs say the Local harness is deprecated and will be removed by February 2027. VS Code asks you to trust the server on first start, and asks for the token once.
3. Copilot CLI: export `MEGALENS_TOKEN`, start `copilot` in the repo and ask it to review your change with MegaLens. The CLI has no prompt files, so you type the request. The config writes `"${MEGALENS_TOKEN}"` for the CLI to expand. If the server reports that the token is not set, update the CLI or use `--token-file`.
4. Docs: https://code.visualstudio.com/docs/agents/reference/mcp-configuration, https://code.visualstudio.com/docs/agent-customization/prompt-files, https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers, https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference

## Use

    /megalens-review                 your change vs the merge base with main (committed branch work, staged, unstaged and new files)
    /megalens-review main            the same, against another base ref
    /megalens-review abc123..def456  a commit range (file contents are read at the end commit)
    /megalens-review --staged        staged changes only

1. Claude reads the change and writes its own review.
2. Claude calls `megalens_review_change` with that review. The tool collects the bundle, sends it as one `megalens_debate` call, polls until the run finishes and returns the MegaLens result, followed by a line with the bundle size and sha256.
3. Claude shows what the panel found that its own review did not, then the findings. Check each finding against your code before changing anything.
4. If the result lists files the panel wanted, Claude is told to read them and call the tool one more time with them added. That second call is a second review run and is charged again. The tool does not enforce the limit of two calls. The instruction text does.

**Comparing hashes.** The tool reports `bundle_sha256`, the hash of the exact `fileContext` it sent. It is also written to the audit log and put in the request prompt as `[megalens-plugin bundle sha256=...]`. To check that a bundle matches, run `node scripts/collect.mjs --json --max-bytes N` and hash its `bundle` field, using the same repository state, the same range and the same N as the `budget=` value in the tool's last line. Files you add after a result (`extraContext`) are part of the sent bundle, so a review that used them will not match.

## What is sent

One `megalens_debate` call with these fields, plus `tier: standard`:

1. `fileContext`, built by `scripts/collect.mjs` in this order:
   1. `=== DIFF ===`, the unified diff, at most 45% of the budget. If it is larger, long sections are cut with a note, and some may be left out.
   2. `=== FILE: path ===` for every changed file, largest change first. A file over 60 KB, or a set that does not fit, is cut to windows around the changed lines, with line numbers, at the widest radius that fits all of them (40, 10, 3 or 0 lines). As a last resort each file gets an equal share of the budget. The manifest says what was cut. With `--staged`, content comes from the index, not the working tree. If nothing reviewable is left, nothing is sent and the tool says why.
   3. Context tests: tests named for a changed file or that use a changed symbol.
   4. Other context, by score: files that call a changed symbol, files that define a symbol the change calls, and config files the change names or whose environment variables it reads. At most 40 context files. A context file over 14 KB is cut to the lines around the matches.
2. `prompt`: the review request, the contents of `.megalens/rules` if present, and the bundle sha256.
3. `yourAssessment`: Claude's own findings, each with the line it concerns.

To see what would be sent, run `node scripts/collect.mjs --max-bytes 200000`. It prints a manifest and then the bundle, and sends nothing. `--json` prints JSON. Without `--max-bytes` the collector uses 90 KB (the fallback command's limit), not the tool's 200 KB.

What the collector leaves out (rules in `scripts/lib/safety.mjs`):

1. Lockfiles, binaries, build output, vendored code and generated files (`*.min.js`, `*.pb.go`, files with an `@generated` style header, snapshots, SVG).
2. Files with secret-looking names, such as `.env` (but not `.env.example`), `*.pem`, `*.key`, `id_rsa`, `credentials`, `.npmrc` style files with an auth token, and `terraform.tfstate`.
3. Any file, diff section, `.megalens/rules` or `extraContext` whose content looks like a credential: private keys, AWS key ids, GitHub, GitLab, Slack, Stripe, Google and MegaLens tokens, `sk-` keys, and JWTs. This check has false positives, and a test fixture with a fake key is skipped too. It is a safety net. Do not rely on it for a file that should never be in the repo.
4. Config files that often hold credentials, when they are only context and you did not change them (for example `database.yml`, `settings*.py`, `wp-config*.php`, `*.ini`, `*.conf`, `*.toml`, `docker-compose*.yml`, `Dockerfile*`). If your change touches one, it is sent as a changed file with the redaction below.
5. Symlinks, and anything whose real path is outside the repository.
6. Diff sections whose file name cannot be parsed.

**Redaction.** In every diff and every file the collector sends, values of keys whose names contain `pass`, `secret`, `token`, `api_key`, `private_key`, `access_key` or `credential` are replaced with `***REDACTED***`. Quoted values are handled in any file. Unquoted values are handled in config style files (yaml, ini, env, properties, shell and similar). Line counts do not change, and the manifest gives the count per file. Values such as `${VAR}`, empty values and booleans are kept. This is pattern matching and can miss a secret. Redaction does not apply to `extraContext` from the model or to the text of `yourAssessment`, which are only checked as described in item 3 above.

The manifest lists every file that was skipped, redacted or left out for space.

The range argument must be `--staged`, a ref, `A..B` or `A...B`, with no options, spaces or shell characters. The fallback command passes it to the collector on stdin, through a quoted heredoc.

## Failures and retries

1. Each network request times out after 90 seconds.
2. While polling, timeouts, HTTP 5xx and 429 responses and unreadable replies are retried until the poll deadline (25 minutes by default). Other errors stop the poll.
3. The `megalens_debate` call is never repeated by the tool. If it times out or fails with a transient error, a run may already have started and may be charged. The tool then tells the model not to call again and to check `megalens_history` on the remote server, or your MegaLens dashboard, before doing anything else. Do the same: do not start a second review for the same change until you have checked.
4. If the poll deadline passes, the tool returns the run id so the result can be fetched with `megalens_poll`.

## Size limits and cost

The default bundle limit is 200 KB and the maximum is 700 KB. Set `MEGALENS_MAX_BYTES`, or `maxBytes` in the tool call. The tool keeps the whole request under 950 KB. If JSON escaping pushes it over, it collects again with a smaller budget, up to five times, and then reports an error. The fallback command stays at 90 KB. `MEGALENS_MAX_BYTES` raises it, but a larger copy by hand gives more room for errors.

The plugin requests the `standard` tier. The server uses `free` for a first free review, and for an account that uses its own key without Pro. A typical paid review is charged by the amount of code sent, and a repeated call (see Use, step 4) is charged again.

## Privacy

The bundle goes to megalens.ai and the model providers it uses. Read https://megalens.ai/privacy before sending code you do not own or that is under NDA. The exclusions above reduce what is sent. They do not guarantee that no secret is sent, so run `node scripts/collect.mjs --max-bytes 200000` and read the output before reviewing sensitive code.

## `.megalens/rules`

A plain text file in the repository, shared by the team. Up to 8 KB is sent with each review inside the prompt, as the repository's review instructions. If the file is longer, it is cut at 8 KB with a note. If it looks like it holds a credential, it is not sent. One rule per line, in plain words. Lines starting with `#` are comments for people, but they are sent too, so keep them short. Example:

    # Rules for this repo
    Money is stored as integer cents; flag any float arithmetic on prices.
    Every route under src/api/ must check the session before reading the body.
    Ignore anything under legacy/; it is scheduled for deletion.
    Do not suggest new dependencies.

Rules guide the review. They do not verify a finding, and they do not keep anything out of the upload. Never put secrets in this file.

## Tests

    npm test

This runs 75 tests in `tests/collect.test.mjs`, `tests/mcp-server.test.mjs`, `tests/security.test.mjs`, `tests/review2.test.mjs` and `tests/install.test.mjs`. They use throwaway git repositories and a mock MegaLens endpoint, so no real calls are made. They cover the installer (merging, backups, no token by default, `--token-file`, re-running), the collector (size limit, skipping, ordering, redaction, ref and range arguments, rules), and the local server (handshake, hash, bearer header, polling, SSE replies, budgets, missing token, errors, `extraContext`).
