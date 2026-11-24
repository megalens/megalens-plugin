---
name: megalens-review
description: Review your current branch or pull request with MegaLens on your own GitHub Actions runner (standard or deep tier, works on Windows, macOS, and Linux).
---
# MegaLens Review (Current Branch / PR)

Only run this when the user explicitly invokes `/megalens-review` or asks for a MegaLens review. It starts a review on the user's GitHub Actions runner and spends MegaLens credits (Standard: 1 credit, Deep: 8 credits).

## Steps

1. Parse any user arguments:
   - Tier: `standard` (default) or `deep`. If the user asks for `double`, tell them "The Double tier is not available yet; use standard or deep." and stop without calling any tool.
   - Optional target: `--pr <number>` (digits only) OR `--base <ref> --head <ref>`. If omitted, the tool automatically detects an open PR for the current branch or falls back to the current branch vs the default branch merge-base.
   - Do not invent other flags.
2. Tell the user: “The diff and code excerpts pass through the MegaLens gateway to OpenAI. MegaLens does not keep your code; it passes through our gateway to the AI provider for the review and is not stored.” Wait for the user to approve that transfer for this review.
3. Call the MCP tool `megalens_cursor_review` (server `megalens-runner`) with `{ tier, pr, base, head, cwd: "<current workspace absolute path>", allow_gateway: true }` (omitting unused fields).
   - If the `megalens-runner` MCP server is unavailable, run `node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-cli.mjs" review --allow-gateway <args>` in the workspace directory.
4. Handle the response carefully:
   - If it prints `Review started on GitHub: gh:<number>`, tell the user the `gh:<number>` id and the GitHub Actions run URL, and tell them to check with `/megalens-status` and view findings with `/megalens-result`. Do not wait, and never claim the change is clean — nothing has been reviewed yet.
   - If it says `NEEDS THE USER'S OK` (unpushed commit), ask the user that exact question and stop. Never run `git push` without the user's explicit yes.
   - If it stops for uncommitted changes or says "do NOT start another one", relay the message verbatim and never start a second run.

   If a setup step is missing, relay the fix printed by the tool. For a missing `MEGALENS_TOKEN` secret, ask the user to run `npx megalens-review init` in their repository and sign in through their browser. It passes the token to `gh` on stdin. Relay manual token entry only if browser setup is unavailable, and keep it in the user's terminal. Once set up, this command dispatches `.github/workflows/megalens-dispatch.yml` from the default branch.
