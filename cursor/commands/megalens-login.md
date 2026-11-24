---
name: megalens-login
description: Check GitHub CLI login and guide browser setup for the MegaLens GitHub Actions runner in this repository.
---
# MegaLens runner setup

Check whether this repository is ready for `/megalens-review`.

## Steps

1. First call `megalens_cursor_signin_status` (server `megalens-runner`) with `{ cwd: "<current workspace absolute path>" }` to inspect sign-in and repository runner readiness.
2. If GitHub CLI needs a login, ask the user to run `gh auth login --hostname github.com --git-protocol https --web --scopes workflow` in their terminal.
3. If the `MEGALENS_TOKEN` secret is missing, ask the user to run `npx megalens-review init` in the repository and sign in through their browser. It passes the token to `gh` on stdin to set the repository secret without asking the user to paste it. The user can decline the separate pull request for automatic PR reviews. If browser setup is unavailable, relay the manual fallback from the tool and keep token entry in the user's terminal.
4. If the dispatch workflow is missing, follow the tool's instructions to put `templates/megalens-dispatch.yml` at `.github/workflows/megalens-dispatch.yml` on the default branch. `/megalens-review` dispatches this workflow.

For hosted MCP, open **Customize** in Cursor, find **megalens**, and click **Connect** to sign in through the browser.
