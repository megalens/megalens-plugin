---
name: megalens-fix-prompt
description: Build and copy a ready-to-paste fix prompt for a finding from the latest MegaLens review result.
---
# MegaLens Fix Prompt

Generating or copying a fix prompt uses 0 credits and makes no extra model calls.

## Steps

1. Parse any user arguments:
   - A finding number (e.g. `1`, `#2`), a finding id (e.g. `f1`), or `--all`. If omitted, the tool automatically picks the finding when there is only one, or lists the numbered findings so the user can choose.
   - Use `--id gh:<digits>` for a specific run. With no run ID, the tool looks for a review of the current commit.
   - Pass `copy: true` when the user asks to copy it to the clipboard (or by default on `/megalens-fix-prompt`).
2. Call the MCP tool `megalens_cursor_fix_prompt` (server `megalens-runner`) with `{ cwd: "<current workspace absolute path>", finding, all, id, copy: true }` (omitting unused fields).
   - If the `megalens-runner` MCP server is unavailable, run `node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-cli.mjs" fix-prompt <args> --copy` in the workspace directory.
3. Present the returned fenced `text` code block verbatim so Cursor shows a one-click Copy button, along with whether it was also copied to the clipboard. Do not modify or execute code changes automatically unless the user asks you to apply the fix.
