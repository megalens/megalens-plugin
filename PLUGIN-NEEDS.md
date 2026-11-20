# What the plugin needs from the engine CLI (engine-v2, not modified here)

1. **A way to get `megalens-review` itself.** The engine now has `install` / `verify` for the pinned Codex CLI (the plugin passes them through as `engine.mjs install|verify`), but the `megalens-review` package is not published. Needed: a release path and an install line for the README.
2. **A stable "still running" signal.** `result` on a running review exits 4 with the stderr text `review is still running`; `unknown review id` likewise. The plugin matches those strings. A distinct exit code, or `state` in a JSON body on stdout, would be sturdier.
3. **A refusal document.** A gateway refusal at prepare time exits 3 with stderr only and no findings file. The plugin renders that as "not completed". If the engine wrote a `status: failed, refused: true` document in that case too, the wording could name the cause (quota, spend cap, sign-in) without parsing stderr.
4. **Background-run hand-off.** `run --background` prints `{review_id, state}` on stdout. Confirm that the review id and state directory survive a Claude Code restart (the plugin assumes `status` and `result` work from any later session and any working directory).
5. **Per-tier timing.** Deep takes about 20 minutes; the plugin cannot show progress. A `status` field with passes done and elapsed minutes would help.
6. **macOS.** The engine refuses to run on macOS (no sandbox profile yet), so the commands report "failed to run" there.
7. **byo-login and byo-key.** Both disabled in the plugin (`BYO_LOGIN_ENABLED = false`, `BYO_KEY_ENABLED = false` in `scripts/lib/engine-core.mjs`, no env or flag switch; CONTRACT section 7). Turning one on means changing the constant in a reviewed release. Tests reach the byo-key path only through the `flags` argument of `main` / `chooseAuth`, which production code never passes. byo-login also needs design 02 test T26 on the real CLI.
9. **Env names.** The plugin passes the engine only `MEGALENS_STATE_DIR`, `MEGALENS_API_URL` and the token (gateway) or key (byo-key), plus basic variables (PATH, HOME, ...). If the engine needs another variable, say so here.
8. **Real-CLI check.** Nothing here was run against the real engine. The fake binary follows `src/cli.mjs`, the README and DEVIATIONS.md as read.

10. **Root.** The engine refuses to run as root unless `MEGALENS_ALLOW_ROOT=1`; the plugin deliberately does not pass that variable, so root shells fail closed (README says so).
11. **Exit 3 for BYO.** The plugin refuses the BYO modes itself, before the engine, so the engine's exit-3 BYO refusal is only a second line of defence here.
