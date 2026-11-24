---
name: megalens-status
description: Check the status of your latest MegaLens review (or a specific gh:<id> run) without spending credits.
---
# MegaLens Review Status

Checking review status uses 0 credits.

## Steps

1. If the user passed a review id, check that it is strictly `gh:` followed by digits only (e.g. `gh:123456789`). If it is invalid, say so and stop. If omitted, the tool checks the latest MegaLens review in this repository.
2. Call the MCP tool `megalens_cursor_status` (server `megalens-runner`) with `{ cwd: "<current workspace absolute path>", ...(id ? { id } : {}) }`.
   - If the `megalens-runner` MCP server is unavailable, run `node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-cli.mjs" status [gh:<id>]` in the workspace directory.
3. Relay the exact state and GitHub Actions run URL:
   - If `queued` or `running`, say so and do not guess at findings.
   - If `done`, point the user to `/megalens-result`.
   - If `failed`, say so in the first sentence: the review did not complete and is not a clean review.
