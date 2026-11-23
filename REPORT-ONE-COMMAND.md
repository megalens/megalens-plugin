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

## Fix round

Addresses all 9 points from `/root/review-input/rv-plugin-one-cmd/SOL.md` (preserving all prior security and fallback fixes):

1. **App path on-demand start & `deep` handling (`SOL.md` #1):**
   - **Fixed in plugin (`scripts/lib/gh-runner.mjs`, `scripts/engine.mjs`):** When both the MegaLens GitHub App and `.github/workflows/megalens-dispatch.yml` are present on a repository and the App has no check run for `headSha` (e.g. a pushed feature branch without an open PR), auto-pick now transparently falls back to the dispatch workflow (`allowNoCheckFallback`) and starts a review on demand without emitting a spurious App error. `deep` also routes to the dispatch workflow when present.
   - **External server boundary (evidence):** For App-only repositories (no dispatch workflow), the plugin cannot trigger an on-demand review or run `deep` on the MegaLens GitHub App without a backend change: the App backend only handles `installation`, `installation_repositories`, `pull_request`, and default-branch `push` webhooks (`/root/wt/github-app-a/src/lib/github-setup/flag.ts:53-54`, `/root/wt/github-app-a/src/lib/github-setup/webhook.ts:128,312`), only supports the `standard` tier (`/root/wt/github-app-a/src/lib/github-setup/flag.ts:20`), and exposes no on-demand review-start route under `/root/wt/github-app-a/src/app/api/github-app/`. Documented in `PLUGIN-NEEDS.md` #12; covered by `SOL-1` test in `tests/one-command.test.mjs`.

2. **App detection via live installation & repository access (`SOL.md` #2):**
   - **Fixed (`checkAppInstallation` & `detectRemoteRunner` in `scripts/lib/gh-runner.mjs`):** Queries GitHub's live installation endpoints first: `GET /orgs/{owner}/installations` (paginated, checking `app_slug`, `!suspended_at`, and `repository_selection`) and `GET /user/installations` + `GET /user/installations/{id}/repositories` (paginated). A newly installed App with zero prior checks is now detected, and a removed or suspended App is definitively rejected even when historical checks exist, so it never suppresses the workflow fallback.
   - **Fallback safety & GitHub API boundary:** When GitHub denies both installation endpoints to the user's `gh` token (e.g. a personal repository or non-org-admin using a standard `gh` OAuth token — GitHub restricts `GET /repos/{owner}/{repo}/installation` to App JWT auth, documented in `PLUGIN-NEEDS.md` #12), detection inspects `headSha` first and never lets stale `defaultBranch` check history suppress a present dispatch workflow (`allowHistoryFallback: !hasWorkflow`). Covered by `SOL-2` test in `tests/one-command.test.mjs`.

3. **Linux runner order & single-line setup message (`SOL.md` #3):**
   - **Fixed (`chooseRoute` in `scripts/lib/gh-runner.mjs`, `runAutoRemote` in `scripts/engine.mjs`):** No-flag `/megalens:review` now follows the same order on Linux as macOS/Windows: **GitHub App → GitHub Actions workflow → local engine (Linux only, when no remote runner is configured and local credentials are set) → one setup line**. Without local credentials or either remote runner, Linux prints strictly the single setup line with no appended local-engine explanation. Covered by `SOL-3` test in `tests/one-command.test.mjs` and updated route tests in `tests/gh-runner.test.mjs`.

4. **Deadline & cancellation on in-flight child processes and Local Standard (`SOL.md` #4):**
   - **Fixed (`raceWithDeadline` & `waitForReview` in `scripts/lib/wait-loop.mjs`, `realExec` in `scripts/lib/gh-runner.mjs`, `runBin` & local review paths in `scripts/engine.mjs`):**
     - Added `raceWithDeadline` passing a per-call `AbortSignal` to every in-flight poll and result-fetch call (`runnerStatus`, `runnerResult`, `appStatus`, `findAppCheckRun`, `localStatus`, `fetchAndRender`), immediately resolving and killing the spawned child (`SIGTERM` + unref'd `SIGKILL` fallback) when either `signal` aborts or `waitMs` expires.
     - Removed the overtime post-deadline poll and rejected any poll that finishes at or after the deadline (`now() - t0 >= waitMs`).
     - Wired the same deadline cap, cancellation, and periodic elapsed progress updates to **Local Standard** as well as Local Deep and remote runners.
     - Covered by `SOL-4` tests in `tests/one-command.test.mjs` (overtime fake-clock poll, hanging real-clock poll abort, slow `gh run download` timeout, Local Standard abort & deadline, and `realExec` abort).

5. **No-id `/megalens:status` and `/megalens:result` always pick the newest review (`SOL.md` #5):**
   - **Fixed (`findLatestRemoteReview` in `scripts/lib/gh-runner.mjs`, `pickNewerReview` in `scripts/engine.mjs`, `saveLatestReview` in `scripts/lib/latest-review.mjs`):**
     - `findLatestRemoteReview` inspects **both** the latest MegaLens App check run on `HEAD` and the latest `MegaLens Dispatch` workflow run, returning whichever started more recently by timestamp (`started_at`/`completed_at` vs `createdAt`).
     - No-id `status`/`result` compares the saved bookmark against `findLatestRemoteReview` via `pickNewerReview` (and stores GitHub's own timestamp when saving remote bookmarks), so a newer remote review always beats an older cached bookmark.
     - Covered by `SOL-5` test in `tests/one-command.test.mjs`.

6. **App path never silently ignores `--base` (`SOL.md` #6):**
   - **Fixed (`appPreflight` / `appReview` in `scripts/lib/gh-runner.mjs`, `runAutoRemote` in `scripts/engine.mjs`):** Explicit `--base`/`--head` ranges are automatically routed to the GitHub Actions workflow when present, and rejected immediately with `MSG.appRangeUnsupported` (`code: 4`) on App-only repos or `--runner app` before reading any check run. Covered by `SOL-6` test in `tests/one-command.test.mjs`.

7. **Claude Code long-wait Bash continuation (`SOL.md` #7):**
   - **Fixed (`commands/review.md`):** Explicitly instructs Claude to pass the 10-minute maximum foreground Bash timeout (`timeout: 600000`) and, if Claude Code moves the Bash command to the background, to never start a second review command and instead follow the background task through its completion notification / task output file until the script finishes (preserving `allowed-tools` and all F2/F3/R7 rules). Covered by `SOL-7` test in `tests/one-command.test.mjs`.

8. **Full redaction of stateless `ghs_APPID_JWT` tokens (`SOL.md` #8):**
   - **Fixed (`scrub` in `scripts/lib/engine-core.mjs`, `scrubExact` in `scripts/lib/gh-runner.mjs`, `CONTENT_PATTERNS` in `scripts/lib/safety.mjs`):** Redacts full stateless `gh[pousr]_APPID_JWT` tokens (with `.`/`-`/`=` segments), standalone JWTs, and even publisher-pre-truncated `[redacted].eyJ<payload>.<sig>` tails so neither header, payload, nor signature can appear in plugin output. Covered in `tests/one-command.test.mjs` and `tests/gh-runner.test.mjs`.

9. **Strip publisher-embedded `rv_…` review IDs on clean App results (`SOL.md` #9):**
   - **Fixed (`stripPublisherReviewId` & `renderAppCheckRun` in `scripts/lib/gh-runner.mjs`):** On clean completion (`state === 'done' && !showId`), strips the publisher's `Review: \`rv_…\`` metadata (from `format.js:287`) and hidden `<!-- megalens-review-summary/meta -->` HTML markers while preserving `Tier`, findings, and keeping review IDs on explicit `app:<id>` lookups or partial/failed runs. Covered by `SOL-9` test in `tests/one-command.test.mjs`.

### Verification (Fix round)

- Full test suite (`npm test`): **167 passed, 0 failed** across all 8 test files.
- No secrets printed; `/var/www`, `ACTIVE-JOB`, and `.env` untouched.
