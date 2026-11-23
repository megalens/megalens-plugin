# Report: Plugin UX — One Command, No Polling

Date: 2026-11-23
Workspace: `/root/review-input/ws-plugin-ux`

## Summary

`/megalens:review` is now a single command with no flags and no manual polling:

1. **Runner auto-pick** (`detectRemoteRunner` in `scripts/lib/gh-runner.mjs`):
   - Prefers **our review machine via the MegaLens GitHub App** (`app`) when installed on the repository (detected via GitHub check suites / check runs for known MegaLens app slugs, rejecting spoofed third-party slugs).
   - Falls back to the **user's own GitHub Actions runner** (`github`) when `.github/workflows/megalens-dispatch.yml` is present on the default branch.
   - Otherwise prints **one clear setup line** pointing to `https://megalens.ai/app/start` (no multi-screen dump or workflow paste unless `--runner github` was explicitly requested).
   - On Linux when a local `megalens-review` engine + `MEGALENS_TOKEN` is configured, local runs still work and fall back to remote auto-pick if the engine is missing, has no local token, or fails the sandbox pre-check (`sandbox_unusable`).
   - If the user asks for `deep` on a repo with both the GitHub App and the dispatch workflow, auto-pick routes `deep` to the GitHub Actions runner; if only the App is installed, it explains clearly that the GitHub App runs Standard reviews.

2. **In-command wait loop & progress lines** (`scripts/lib/wait-loop.mjs`):
   - Default wait cap is **20 minutes** (`DEFAULT_WAIT_MS = 20 * 60_000`), polling every 15 s (`DEFAULT_POLL_MS`) with non-repeating progress lines:
     - `Review started`
     - `Queued on GitHub...` / `Running on GitHub...` (or `Waiting for MegaLens review machine...` / `Running on MegaLens...`, or `Running locally...`)
     - `About 2 minutes so far`, `About 4 minutes so far`, ...
   - Prints the review findings **inline** when finished.
   - **No review id is shown** on start, progress, cap, or clean completion. Review ids (`app:<id>`, `gh:<id>`, `rv_<id>`) and run/check URLs are shown only when something goes wrong (`FAILED`, `PARTIAL`, `CANCELLED`, `NOT COMPLETED`, or lost run) or when an advanced user explicitly passes an id.
   - Works for both `standard` (default) and `deep` tiers across all three runners.

3. **Cut-short wait & no-id `/megalens:result` / `/megalens:status`** (`scripts/lib/latest-review.mjs`):
   - Immediately after a review starts (before entering the wait loop), a per-repo bookmark is saved outside the repository under `${MEGALENS_STATE_DIR:-~/.megalens}/plugin-state/latest-reviews.json` (`0700` dir, `0600` file, atomic write, symlink-refusing, zero secrets/code).
   - If the 20-minute cap is reached or the user stops the wait (`SIGINT`/`SIGTERM`/`AbortSignal`), the command prints one line:
     `Still running. Run /megalens:result to see it.`
   - `/megalens:result` and `/megalens:status` with **no id** resolve the latest review for the current repository from the bookmark, falling back to remote GitHub lookup (MegaLens App check run on `HEAD`, else latest `MegaLens Dispatch` workflow run) if no local bookmark exists.

4. **Advanced flags preserved, README simplified to 2 steps**:
   - `--runner app|github|local`, `--base REF --head REF`, `--quiet`, `--no-wait`, and explicit ids (`app:<id>`, `gh:<id>`, `rv_<id>`) all keep working for advanced users.
   - `README.md` main path (`Quick start (2 steps)`) is now strictly: (1) install the plugin, (2) `/megalens:review`. Neither `--runner` nor review ids appear in the main path; all advanced options, self-hosted GitHub Actions workflow setup (keeping the pinned `v1.2.0` Action SHA), local Linux engine, legacy MCP bundle route, and other hosts sit under `## Advanced`.

## Files Changed

- `scripts/lib/wait-loop.mjs` (new): shared wait loop with injectable clock (`now`, `sleep`), `AbortSignal`, progress lines, 20-minute cap, and exact still-running line.
- `scripts/lib/latest-review.mjs` (new): per-repo latest-review bookmark store outside the repo (`0700`/`0600`, symlink-safe, id-validated).
- `scripts/lib/gh-runner.mjs`: runner auto-pick (`detectRemoteRunner`, `isAppInstalled`, `hasDispatchWorkflow`), GitHub App check-run runner (`appReview`, `appStatus`, `appResult`, `mapCheckState`), default wait loop on `runnerReview`, remote latest fallback (`findLatestRemoteReview`), id-hiding on clean runs.
- `scripts/lib/engine-core.mjs`: `parseReviewArgs` defaults `wait: true` (adds `--no-wait`); `renderResult` omits `Review <id>` on clean completion unless `showId: true`.
- `scripts/engine.mjs`: wires auto-pick, `app`/`github`/`local` runners, no-id `status`/`result`, local `deep` wait loop, `SIGINT`/`SIGTERM` abort handling, and `--runner app|github|local`.
- `commands/review.md`, `commands/status.md`, `commands/result.md`: updated for one-command waiting UX, optional `deep`, optional id on `status`/`result`, and safety rules preserved.
- `README.md`: 2-step quick start at the top; advanced options moved below `## Advanced`.
- `tests/one-command.test.mjs` (new) + `package.json`: tests for runner auto-pick, spoofed app slug rejection, fake-clock wait loop & progress lines, 20-minute cap & abort, no-id `status`/`result` (bookmark + remote fallback + repo isolation + symlink safety), README main-path checks, and secret scrubbing.
- `tests/engine-v2.test.mjs`, `tests/gh-runner.test.mjs`: updated assertions for default wait, auto-pick, and no-id clean output while preserving all security and fallback invariants.

## Verification

- `npm test`: **159 passed, 0 failed** across all 8 test files (`collect`, `mcp-server`, `security`, `review2`, `install`, `engine-v2`, `gh-runner`, `one-command`).
- No secrets printed; `/var/www` and `ACTIVE-JOB` untouched.
