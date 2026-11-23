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

## Fix round (LOOP-CONFIRM1.md)

Addresses all 7 points from `/root/review-input/rv-plugin-one-cmd/LOOP-CONFIRM1.md` (preserving all prior round-1 and earlier security/fallback fixes):

1. **Delayed App check on App+workflow repos never launches a second billable review (`NEW #1`, `SOL #1`):**
   - **Fixed (`appReview` in `scripts/lib/gh-runner.mjs`, `runViaApp` / `runAutoRemote` in `scripts/engine.mjs`):** Failed closed against double-billing. `appReview` now checks local branch, remote `branches-where-head`, and open PRs (`repos/{nwo}/commits/{sha}/pulls`). Falling back to `workflow_dispatch` (`safeToFallback: true`) is ONLY allowed when we affirmatively confirm zero open PRs (`prRes.code === 0 && openPrs.length === 0`) AND the commit is not on `defaultBranch` (where the MegaLens App webhook cannot fire per `/root/wt/github-app-a/src/lib/github-setup/webhook.ts:249-315`). Whenever an open PR, default-branch commit, or inconclusive PR lookup means the App may already have enqueued a review (`webhook.ts:285-304`), `appReview` waits up to `appearWaitMs` (default 60 s, bounded by `waitMs`/`signal`) for the delayed check and **never** auto-dispatches GitHub Actions. Covered by `LC1-NEW1` and `SOL-1` tests in `tests/one-command.test.mjs`.
   - **External backend boundary (`SOL #1` on App-only repos — unreachable from plugin repo):** The MegaLens GitHub App backend only handles `installation`, `installation_repositories`, `pull_request`, and default-branch `push` webhooks (`/root/wt/github-app-a/src/lib/github-setup/flag.ts:53-54`, `/root/wt/github-app-a/src/lib/github-setup/webhook.ts:128,249-315`), hardcodes `APP_REVIEW_TIER = 'standard'` (`/root/wt/github-app-a/src/lib/github-setup/flag.ts:20`), and exposes only `callback`, `install`, `setup`, `start`, and `webhook` routes under `/root/wt/github-app-a/src/app/api/github-app/*/route.ts` (no on-demand review-start API or `check_suite.rerequested` handler). Documented in `PLUGIN-NEEDS.md` #12.

2. **Historical `HEAD` checks never suppress workflow fallback when live installation APIs are denied (`SOL #2`):**
   - **Fixed (`checkAppInstallation` in `scripts/lib/gh-runner.mjs`):** When live installation endpoints (`orgs/{owner}/installations`, `user/installations`) are accessible, they remain authoritative (detecting zero-check installations and rejecting removed/suspended/unselected Apps). When both live endpoints are denied (403/404) and a dispatch workflow is present (`allowHistoryFallback: false`), historical completed checks and check suites on **both** `HEAD` and `defaultBranch` are ignored so a removed App can never suppress the workflow fallback; only a currently live (`queued`/`in_progress`) MegaLens check run on `HEAD` attaches to the App (avoiding double-billing). Covered by `LC1-SOL2` and `SOL-2` tests in `tests/one-command.test.mjs`.
   - **External GitHub API / backend boundary:** On personal repos or non-admin org accounts with a standard `gh` OAuth token (`gho_*`) and zero prior checks, GitHub restricts `GET /repos/{owner}/{repo}/installation` to App JWT auth, `GET /orgs/{org}/installations` to org admins, and `GET /user/installations` to GitHub App user tokens (`ghu_*`), and the MegaLens backend exposes no repo-status route under `/root/wt/github-app-a/src/app/api/github-app/`. Documented in `PLUGIN-NEEDS.md` #12.

3. **`SIGTERM`-ignoring children are killed by `SIGKILL` and parent exits promptly (`SOL #4`):**
   - **Fixed (`realExec` in `scripts/lib/gh-runner.mjs`, `runBin` in `scripts/engine.mjs`):** Fixed the bug where `finish()` cleared `killTimer` immediately after `onAbort()` scheduled it, preventing the `SIGKILL` fallback from ever firing and leaving the child alive (and blocking parent exit). Children on POSIX now run in their own process group (`detached: true`), `killTimer` (150 ms grace) stays referenced until `child.on('exit')`/`close` clears it, `killChildTree` signals `-child.pid` + `child.kill`, and `child.unref()` runs after `SIGKILL` so both the stubborn child terminates and the parent exits promptly. Covered by `LC1-SOL4` (real `SIGTERM`-ignoring subprocess + parent exit timing + local `runBin`) in `tests/one-command.test.mjs`.

4. **Equal-second tie-breaking & repo-wide App check discovery (`SOL #5`):**
   - **Fixed (`pickNewerReview` in `scripts/engine.mjs`, `findLatestRemoteReview` in `scripts/lib/gh-runner.mjs`):**
     - `pickNewerReview` now breaks equal-second timestamp ties (`rTs === sTs`, since GitHub ISO-8601 timestamps have 1-second resolution) using the numeric run/check ID (`rNum > sNum`) instead of keeping the older bookmark.
     - `findLatestRemoteReview` now checks MegaLens App check runs across `HEAD`, recently updated PR head SHAs (`repos/{nwo}/pulls?state=all&sort=updated&direction=desc&per_page=5`), and `defaultBranch`, and sorts the top 5 `MegaLens Dispatch` workflow runs by `(createdAt, databaseId)` descending. Covered by `LC1-SOL5` and `SOL-5` tests in `tests/one-command.test.mjs`.

5. **Interrupted or ambiguous workflow dispatch reconciles against GitHub (`NEW #2`):**
   - **Fixed (`startRun` & `runnerReview` in `scripts/lib/gh-runner.mjs`):** When `gh workflow run` is aborted (`r.aborted || signal?.aborted`) or fails without a definitive GitHub 4xx refusal (`HTTP 400/401/403/404/422` / missing `workflow_dispatch`), `startRun` now runs a bounded reconciliation `listRuns` lookup with a fresh non-aborted signal. If the accepted run is found, `runnerReview` bookmarks it and prints `Still running. Run /megalens:result to see it.` so `/megalens:result` retrieves it without re-dispatching. If not found yet, it **never** says "GitHub did not start the workflow" — it warns `"A review may already have been started and charged: do NOT start another one"` with the workflow URL. Covered by `LC1-NEW2` in `tests/one-command.test.mjs`.

6. **Interrupted / timed-out Local Standard reports cancellation honestly (`NEW #3`):**
   - **Fixed (`scripts/engine.mjs`):** Because `engine-v2` runs `standard` (and `double`) only in the foreground and cancels on `SIGTERM` without writing `state.json`/`result.json` (`/root/wt/engine-013/packages/engine-v2/src/tiers.mjs:8,15`, `cli.mjs:102,117-135`), interrupting or capping Local Standard no longer prints `Still running. Run /megalens:result to see it.` or returns exit 0, and no longer writes an unretrievable `rv_...` bookmark. Instead it stops the child cleanly and prints `## MegaLens standard review: CANCELLED` (on abort) or `## MegaLens standard review: NOT COMPLETED` (on wait cap) with exit code `4`. Local `deep` (`--background`) continues to stay running and bookmark for `/megalens:result`. Covered by `LC1-NEW3` and updated `SOL-4` tests in `tests/one-command.test.mjs`; engine-v2 background limitation noted in `PLUGIN-NEEDS.md` #13.

### Verification (Fix round — LOOP-CONFIRM1.md)

- Full test suite (`npm test`): **173 passed, 0 failed** across all 8 test files.
- No secrets printed; `/var/www`, `ACTIVE-JOB`, and `.env` untouched.

## Fix round (LOOP-CONFIRM2.md)

Addresses every open point in `/root/review-input/rv-plugin-one-cmd/LOOP-CONFIRM2.md` (preserving all earlier round-1, round-2, security, and fallback fixes):

1. **Local cancellation waits for engine gateway finalization & workspace cleanup (`LOOP-CONFIRM2 NEW #1`):**
   - **Fixed (`runBin`, Local Standard/Double, and Local Deep start in `scripts/engine.mjs`):**
     - Separated fast probe kill grace (`FAST_KILL_GRACE_MS = 150`) from local engine run cancellation grace (`LOCAL_CANCEL_GRACE_MS = 10_000`, injectable via `cancelGraceMs` for tests).
     - On user interrupt (`SIGINT`/`SIGTERM`/`AbortSignal`) or wait-cap timeout during a local review (`waitForExitOnAbort: true`), `runBin` sends `SIGTERM` directly to the `engine-v2` child process first (so `engine-v2`'s `SIGTERM` handler in `/root/wt/engine-013/packages/engine-v2/src/cli.mjs:119-121` cleanly aborts Codex with `aborted = true`, calls `GET /api/v2/reviews/:id` + `POST /api/v2/reviews/:id/complete` with `{"outcome":"cancelled"}` at `engine.mjs:391,475`, and deletes `workspace_dir` in `engine.mjs:243`), and **waits for the engine process to exit** (up to `cancelGraceMs`) BEFORE printing `## MegaLens standard review: CANCELLED` / `NOT COMPLETED` and returning exit `4`.
     - If the engine exits cleanly on `SIGTERM`, any stray process-group descendants are reaped and the gateway slot is already closed so an immediate retry succeeds without hitting `account_concurrency` (`/root/wt/github-app-a/src/lib/engine-v2/service.ts:406-412`). If a stubborn engine ignores `SIGTERM` past `cancelGraceMs`, `killChildTree(child, 'SIGKILL')` force-stops the process group and the message honestly warns that it was force-stopped.
     - Verified by `LC2-NEW1` in `tests/one-command.test.mjs` (600 ms gateway finalization on both abort and timeout, plus stubborn force-stop warning) AND verified against the real `/root/wt/engine-013/packages/engine-v2/src/cli.mjs` offline repro (`POST /api/v2/reviews`, `GET`, `POST /complete` `{"outcome":"cancelled"}`, `workspaceRemains: false`).

2. **Initial `appReview` check-runs / preflight and `runnerReview` preflight / dispatch bounded by `waitMs` (`SOL #4`):**
   - **Fixed (`appReview`, `runnerReview`, `startRun` in `scripts/lib/gh-runner.mjs`; `runAutoRemote` in `scripts/engine.mjs`):**
     - Captured `t0 = now()` at the very start of `appReview` and `runnerReview` and wrapped `appPreflight`, initial `findAppCheckRunWithStatus`, `git branch`, `branches-where-head`, `pulls`, `preflight`, and `startRun` list/dispatch/poll calls in `raceWithDeadline(..., { signal, remainingMs, now, t0, waitMs })`.
     - An overtime initial `check-runs` lookup is aborted at `waitMs` and returns `code: 4, timedOut: true` instead of waiting past the deadline and accepting the check as `complete`.
     - Covered by `LC2-SOL4` in `tests/one-command.test.mjs` (alongside existing `SOL-4` and `LC1-SOL4` tests).

3. **Inconclusive `branches-where-head` or `check-runs` lookup fails closed against double-dispatch (`LOOP-CONFIRM1 NEW #1`):**
   - **Fixed (`findAppCheckRunWithStatus` & `appReview` in `scripts/lib/gh-runner.mjs`):**
     - `appReview` now checks `bwhCheckOk = bwh.code === 0 && Array.isArray(bwhList)` and `initialCheckOk` from `findAppCheckRunWithStatus` in addition to `prCheckOk`. Whenever `branches-where-head` returns an API error (e.g. `HTTP 502`) or `check-runs` fails, `mayBeTriggeredByApp` fails closed (`true`, `safeToFallback: false`) so `workflow_dispatch` is never launched on top of an App review.
     - Covered by `LC2-NEW1-BWH` in `tests/one-command.test.mjs` (and fixed `makeScenario` in `tests/one-command.test.mjs` to mock `branches-where-head` explicitly).
   - **External GitHub API / backend boundary (`unknown-live-installation` on personal repos / non-admin org tokens — `SOL #2` & `LOOP-CONFIRM1 NEW #1`):**
     - When `GET /orgs/{owner}/installations` and `GET /user/installations` both return `403`/`404` (personal repo or non-admin org account using a standard `gh` OAuth token) AND `.github/workflows/megalens-dispatch.yml` is present with zero active check runs on `HEAD`, GitHub's REST API provides identical responses (`403`, `403`, `check_runs: []`) for (a) a pure GitHub Actions repo that never installed the App, (b) a repo that uninstalled the App (`SOL #2`), and (c) a repo with the App installed whose check has not yet been created (`LOOP-CONFIRM1 NEW #1`). Blocking workflow dispatch on `403`/`403`/`[]` would break all personal-repo GitHub Actions users. Resolving this requires a MegaLens backend repo-status endpoint (none exists under `/root/wt/github-app-a/src/app/api/github-app/{callback,install,setup,start,webhook}/route.ts`; tracked in `PLUGIN-NEEDS.md` #12).

4. **Broader no-id remote App check discovery & sub-second bookmark tie-breaking (`SOL #5`):**
   - **Fixed (`findLatestRemoteReview` in `scripts/lib/gh-runner.mjs`, `pickNewerReview` in `scripts/engine.mjs`):**
     - Expanded `findLatestRemoteReview` to probe up to 20 recently updated PR head SHAs (`repos/{nwo}/pulls?...&per_page=20`) plus the 10 most recent commits on `defaultBranch` (`repos/{nwo}/commits?sha=${defaultBranch}&per_page=10`) in bounded batches of 5.
     - Updated `pickNewerReview` to compare same-source GitHub timestamps at 1-second resolution so local `Date.now()` milliseconds on a saved bookmark cannot outrank a newer GitHub ISO-8601 run/check from the same second before the numeric ID tie-breaker runs.
     - Covered by `LC2-SOL5` in `tests/one-command.test.mjs`.
   - **External GitHub API / backend boundary:** GitHub REST has no repo-wide `GET /repos/{owner}/{repo}/check-runs` endpoint (check runs can only be queried per commit ref `commits/{ref}/check-runs`); discovering an App check on an arbitrary older ref outside `HEAD`, the 20 most recently updated PRs, and the 10 most recent default-branch commits requires a MegaLens backend latest-review endpoint (tracked in `PLUGIN-NEEDS.md` #12).

5. **External boundaries confirmed unchanged (`SOL #1`, `LOOP-CONFIRM1 NEW #3`):**
   - **`SOL #1` (App-only on-demand start & `deep`):** Unreachable from this plugin repo without backend changes — `/root/wt/github-app-a/src/lib/github-setup/flag.ts:20,53-54` pins `APP_REVIEW_TIER = 'standard'` and `HANDLED_EVENTS = ['installation', 'installation_repositories', 'pull_request', 'push']`, `/root/wt/github-app-a/src/lib/github-setup/webhook.ts:128,253-320` only enqueues on `pull_request` / default-branch `push` webhooks, and `/root/wt/github-app-a/src/app/api/github-app/` has no on-demand start route. Documented in `PLUGIN-NEEDS.md` #12.
   - **`LOOP-CONFIRM1 NEW #3` (retrieving interrupted Local Standard via `/megalens:result`):** Unreachable from this plugin repo without `engine-v2` changes — `/root/wt/engine-013/packages/engine-v2/src/tiers.mjs:6-12` sets `TIERS.standard.background = false` and `cli.mjs:102,117-135` rejects `--background` for `standard` and writes no disk `state.json`/`result.json` on interrupt. The plugin stops Local Standard cleanly (letting `engine-v2` close the gateway review and remove its snapshot) and reports `CANCELLED` / `NOT COMPLETED` (exit `4`) without writing a broken bookmark. Documented in `PLUGIN-NEEDS.md` #13.

### Verification (Fix round — LOOP-CONFIRM2.md)

- Full test suite (`npm test`): **177 passed, 0 failed** across all 8 test files.
- Real `/root/wt/engine-013/packages/engine-v2/src/cli.mjs` offline cancellation repro (600 ms gateway `GET`): confirmed `POST /api/v2/reviews`, `GET /api/v2/reviews/rv_confirm001`, `POST /api/v2/reviews/rv_confirm001/complete` (`{"outcome":"cancelled"}`), `workspaceRemains: false`, `code: 4`, `## MegaLens standard review: CANCELLED`.
- No secrets printed; `/var/www`, `ACTIVE-JOB`, and `.env` untouched.
