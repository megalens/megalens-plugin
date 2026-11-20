# What the plugin needs from the engine CLI (engine-v2, not modified here)

1. **A way to install it.** The plugin only finds `megalens-review` on PATH or via `MEGALENS_REVIEW_BIN`. There is no published package, and no pinned Codex install flow is wired to the plugin. Needed: a release path and an install line for the README.
2. **A stable "still running" signal.** `result` on a running review exits 4 with the stderr text `review is still running`; `unknown review id` likewise. The plugin matches those strings. A distinct exit code, or `state` in a JSON body on stdout, would be sturdier.
3. **A refusal document.** A gateway refusal at prepare time exits 3 with stderr only and no findings file. The plugin renders that as "not completed". If the engine wrote a `status: failed, refused: true` document in that case too, the wording could name the cause (quota, spend cap, sign-in) without parsing stderr.
4. **Background-run hand-off.** `run --background` prints `{review_id, state}` on stdout. Confirm that the review id and state directory survive a Claude Code restart (the plugin assumes `status` and `result` work from any later session and any working directory).
5. **Per-tier timing.** Deep takes about 20 minutes; the plugin cannot show progress. A `status` field with passes done and elapsed minutes would help.
6. **macOS.** The engine refuses to run on macOS (no sandbox profile yet), so the commands report "failed to run" there.
7. **byo-login.** Disabled in the plugin (`BYO_LOGIN_ENABLED = false` in `scripts/lib/engine-core.mjs`, no env switch) until the owner clears OpenAI's terms and design 02 test T26 passes on the real CLI.
8. **Real-CLI check.** Nothing here was run against the real engine. The fake binary follows `src/cli.mjs`, the README and DEVIATIONS.md as read.
