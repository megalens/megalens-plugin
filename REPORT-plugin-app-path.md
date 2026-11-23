# Report: `plugin-app-path` — GitHub App On-Demand Path in `/megalens:review`

Branch: `feat/plugin-app-path` in `/root/review-input/ws-plugin-app-path` (standalone clone; nothing pushed, published, or deployed).

## What was built

Turned on the MegaLens GitHub App review path (`APP_PATH_ENABLED = true`) and wired the Claude Code plugin to the live MegaLens on-demand App API (`GET /api/github-app/status`, `POST /api/github-app/review-now`, and `GET /api/github-app/review-now/[id]`).

1. **Runner selection order for `/megalens:review` (no flags):**
   - **First:** If `MEGALENS_TOKEN` is set, check `GET /api/github-app/status?repo=<owner/name>`. When the App is installed, linked to the signed-in account, active (not suspended), and its setup notice is accepted, run the review through the MegaLens GitHub App (both `standard` and `deep` tiers). Also supports App-only users without `gh` CLI by parsing `owner/repo` from `git remote get-url origin`.
   - **Second:** Otherwise, if `.github/workflows/megalens-dispatch.yml` exists on the default branch, run on the user's GitHub Actions runner (also used automatically when `--base REF --head REF` is passed and the workflow is present).
   - **Third:** Otherwise print the single setup line:
     `Install the MegaLens GitHub App or add the workflow: https://megalens.ai/app/start`
2. **One-command inline App review UX:**
   - Detects an open, non-draft, same-repo pull request matching `HEAD` (via `gh pr view`) and submits `{ repo, tier, pr }`; otherwise submits `{ repo, tier, ref: <headSha> }`.
   - Uncommitted changes stop before any API call; unpushed commits ask the user before pushing.
   - Polls `GET /api/github-app/review-now/<uuid>` with short progress lines (`Review started`, `Waiting for MegaLens review machine...`, `Running on MegaLens...`, `About N minutes so far`) up to the 20-minute cap, then prints findings inline via the shared `renderResult` formatter.
   - Clean completions print no job UUID, `rv_` ID, or `/megalens:status` / `/megalens:result` commands.
   - Handles every terminal state honestly (never calling failures clean): `no_credits` (plain message with `https://megalens.ai/app/settings/billing`), `failed`, `cancelled`, `skipped`, `done` + `partial` (exit 2), `too_large`, `stale`, and 24-hour expired findings (`RESULT EXPIRED`).
   - Maps all server HTTP error codes (`401 unauthorized`, `404 not_found`/`target_not_found`, `409 installation_suspended`/`notice_required`/`review_finishing`, `422 target_unavailable`, `429 daily_cap`/`rate_limited`, `503 unavailable`) to plain-English messages.
3. **One charge per review & lost-reply safety:**
   - Immediately bookmarks `app:<uuid>` (with `nwo`, `tier`, `headSha`, `prNumber`) in `latest-reviews.json` (mode `0600`, no secrets).
   - Re-running `/megalens:review` for the same repo, commit, PR, and tier checks the bookmarked job via `GET /api/github-app/review-now/<uuid>` first and reuses an in-flight (`queued`/`running`) or retained (`done` with findings) job with zero second `POST`.
   - If the reply to `POST /api/github-app/review-now` is lost (network drop or `5xx`), retries the exact same payload at most once after a short delay so the server's idempotent deduplication returns the same `job_id`; if still unconfirmed (or aborted/timed out), stops and warns without looping.
   - `409 review_finishing` is not auto-retried so a finishing webhook job cannot trigger a second paid review.
   - Hitting the 20-minute cap (or interrupting) prints `Still running. Run /megalens:result to see it.` and resumes cleanly via `/megalens:status`, `/megalens:result`, or `/megalens:review` with no ID.
4. **Sign-in token & transport security:**
   - `MEGALENS_TOKEN` is read only from the environment, sent only in `Authorization: Bearer <token>` to a validated origin (`https://` or loopback `http://127.0.0.1|localhost|::1`, no embedded credentials), with `redirect: 'manual'` (redirects refused so Bearer headers never cross hosts), and a 4 MiB response cap.
   - `MEGALENS_TOKEN` is never passed to `gh` or `git` subprocesses (`ghEnv` applied everywhere, including `resolveRepoKey`), never placed in CLI args or URLs, never written to bookmarks, and scrubbed from all output/errors/findings (`scrub` and `scrubExact`).

## Files changed

- [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) — Set `APP_PATH_ENABLED = true`; wired `checkAppStatus`, `detectRemoteRunner`, `appPreflight`, `startAppReview`, `appStatus`, `appResult`, `appReview`, and `renderAppJob` to the three on-demand App endpoints; UUID `app:<uuid>` ID validation; `resolveAppApiBase`, `extractAppToken`, `parseGitHubRemote`, bounded `appApiRequest`, and `scrubExact` updates.
- [scripts/lib/latest-review.mjs](scripts/lib/latest-review.mjs) — Updated `APP_ID_RE` to `app:<uuid>` and stored optional `headSha` and `prNumber` routing metadata (still no tokens/code, `0600` atomic write).
- [scripts/engine.mjs](scripts/engine.mjs) — Wired injectable `fetch`, routed both `standard` and `deep` to App when installed (falling back to workflow for `--base/--head` when present), passed `loadLatest` into `appReview` for in-flight job reuse, updated `app:<uuid>` validation text, and passed `ghEnv(env)` to `resolveRepoKey`.
- [commands/review.md](commands/review.md), [commands/status.md](commands/status.md), [commands/result.md](commands/result.md) — Updated slash-command instructions for the enabled App path and `app:<uuid>` IDs.
- [README.md](README.md) & [PLUGIN-NEEDS.md](PLUGIN-NEEDS.md) — Updated Quick start and Advanced docs in plain words for first-time users; marked item 12 in `PLUGIN-NEEDS.md` resolved.
- [package.json](package.json) — Added `tests/app-path.test.mjs` to `npm test`.
- [tests/app-path.test.mjs](tests/app-path.test.mjs) — New zero-network fixture suite (12 tests) covering App installed (standard/deep, ref/PR, no-`gh`), App not installed (workflow fallback & exact one-line setup), out of credits, all failed/cancelled/skipped/partial/too_large/stale/expired states, 20-min timeout + resume, lost-reply dedupe, submit error codes, poll retries, and token/URL/redirect security.
- [tests/one-command.test.mjs](tests/one-command.test.mjs) & [tests/gh-runner.test.mjs](tests/gh-runner.test.mjs) — Updated existing tests for `APP_PATH_ENABLED = true`, UUID `app:<uuid>` IDs, the live setup line, and fixture `fetch` injection (zero network).

## Flags and environment variables

- **`APP_PATH_ENABLED = true`** (`scripts/lib/gh-runner.mjs`) — Code constant enabling the App path.
- **`MEGALENS_TOKEN`** — Required for the GitHub App path (and local engine). Sent only as `Authorization: Bearer <token>` to the validated MegaLens API origin.
- **`MEGALENS_API_URL`** (optional, falls back to `MEGALENS_URL`, default `https://megalens.ai`) — Overrides the API origin for dev/staging testing; accepts only `https://` or loopback `http://127.0.0.1|localhost|::1` with no credentials.
- **`/megalens:review --runner app|github|local`** — Optional explicit runner override (no flag needed for normal use).
- **`/megalens:status app:<uuid>`** / **`/megalens:result app:<uuid>`** — Optional explicit App job lookup (no ID needed for normal use).

## Tests

Ran full suite (`npm test && git diff --check`) with zero network calls:
- **191 / 191 tests passed** (0 failed, 0 skipped) across all 9 test files:
  `collect.test.mjs`, `mcp-server.test.mjs`, `security.test.mjs`, `review2.test.mjs`, `install.test.mjs`, `engine-v2.test.mjs`, `gh-runner.test.mjs`, `one-command.test.mjs`, and `app-path.test.mjs`.
- `git diff --check` passed with no whitespace/patch errors.

## Owner steps

1. Review the diff on `feat/plugin-app-path` in `/root/review-input/ws-plugin-app-path` (and merge/release when ready).
2. Confirm `GITHUB_APP_V1=on` on production `megalens.ai` (and turn off `GITHUB_APP_TEST_ONLY` when ready for non-test accounts; while `GITHUB_APP_TEST_ONLY` is on, non-allowlisted accounts get `404` on `/api/github-app/status` and gracefully fall back to the workflow or setup line).
3. Run one live smoke test in a real repo with the MegaLens GitHub App installed and `MEGALENS_TOKEN` set (`/megalens:review`, `/megalens:review deep`, and a timeout/resume check via `--no-wait` + `/megalens:result`).

## Open questions

- **Cross-machine no-ID lookup for App reviews:** Because there is no repo-wide `GET /api/github-app/reviews?repo=...` list endpoint yet, `/megalens:status` and `/megalens:result` with no ID find App reviews via the local bookmark (`latest-reviews.json`). If a user starts an App review on machine A and runs `/megalens:result` on machine B without an ID, it will not see machine A's job unless they pass `app:<uuid>` or re-run `/megalens:review` (which deduplicates on the server).
- **Custom `--base/--head` ranges on App-only repos:** `POST /api/github-app/review-now` accepts `pr` or a single `ref` (not arbitrary `base..head` pairs), so `--base/--head` currently routes to the GitHub Actions workflow when present, or explains that the App reviews the open PR or pushed commit otherwise.


## First review

Builder `gemini-4-neon-high`. Reviewed commit `400c975` against `97b17db` and the supplied on-demand API source.

1. **High — Project settings can redirect the editor credential.** The default review sends the bearer token to any HTTPS host supplied by `MEGALENS_API_URL` or `MEGALENS_URL`. Local Claude Code can supply environment variables from a tracked project settings file. A normal review can therefore hand a production credential and the repository name to a non-MegaLens host on its initial status request, even if the App is absent. A mocked request confirmed the header reached the overridden origin. Pin the production App client to `https://megalens.ai` and use injected transport or isolated credentials for tests. [Origin selection](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:183) · [Bearer header](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:304) · [Claude Code settings](https://code.claude.com/docs/en/settings#settings-files-and-who-they-affect)

2. **High — A lost PR reply can start another billable job.** The retry repeats `{repo,tier,pr}`, and each POST resolves the PR's current base and head again. If a teammate pushes between attempts, the queue sees a different head and can admit another job. If the first job completed before the retry, both can settle. The CLI also renders the returned job without checking its `head_sha` and bookmarks it under the old local SHA. The offline fixture reproduced the wrong-head result and bookmark. The existing lost-reply test assigns the same UUID unconditionally on attempt two, so its one-job assertion cannot catch this. Require a stable operation identity bound to the chosen target, or stop a PR submission with an unknown outcome until the first job can be recovered. For `review_finishing`, direct the user to the existing GitHub result. The current invitation to rerun can start a fresh billable review once the automatic job finishes without retained editor findings. [Submit and retry](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1293) · [Bookmark and render](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1500) · [Finishing response](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:950) · [PR resolution](/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:117) · [Queue matching](/root/review-input/ws-ondemand-merge/supabase/migrations/20261123230000_github_app_on_demand.sql:113) · [Lost-reply test](/root/review-input/ws-plugin-app-path/tests/app-path.test.mjs:415)

3. **High — An App status outage can start a second review through Actions.** Runner selection happens before the App bookmark is checked. When both runners are configured and the App status GET returns a transient 503, rerunning after an interruption dispatches Actions without reading the known App job. An offline fixture accepted an App job, returned 503 for the next status check, and recorded a workflow dispatch and zero reads of the saved job. The workflow has its own gateway create step. Resolve a matching App attempt before runner selection and require a definitive fallback signal before dispatching. [Runner selection](/root/review-input/ws-plugin-app-path/scripts/engine.mjs:379) · [Workflow fallback](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:517) · [App resume](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1454) · [Workflow create](/root/review-input/ws-plugin-app-path/templates/megalens-dispatch.yml:33)

4. **High — An editor review can cost credits or a free review even though delivery failed.** The on-demand endpoint can admit this plugin's job with `ONE_PATH_V1` off. The worker records the deferred-settlement policy from that flag alone. In the flag-off branch it settles a complete engine run before GitHub publishing or editor-result retention. A permanent publish error then records a failed job with no editor findings and skips the deferred failure settlement. The user sees a failed review after the wallet has settled. Gate this launch on safe settlement for editor jobs, including reused jobs, and cover a permanent publish failure with `ONE_PATH_V1` off for both paid and free Standard admissions. This is a dependency in the reviewed API source. [Endpoint admission](/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:169) · [Worker claim](/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:374) · [Early settlement](/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:599) · [Publish failure](/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:714) · [Wallet finalization](/root/review-input/ws-ondemand-merge/src/lib/engine-v2/service.ts:338)

5. **Medium — Browser sign-in leaves the first review disconnected.** The plugin only reads `MEGALENS_TOKEN` from the shell. Browser setup saves the credential in Claude Code's MCP configuration. A customer who installs the App, finishes browser sign-in and follows the quick start can still fall through to Actions or be sent back to install the App. Connect the slash command to the existing sign-in credential through a trusted path and test a fresh account with an empty shell environment. [Quick start](/root/review-input/ws-plugin-app-path/README.md:5) · [Token and runner discovery](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:471) · [Claude Code credential storage](/root/review-input/ws-ondemand-merge/packages/mcp/bin/cli.mjs:277) · [Browser setup](/root/review-input/ws-ondemand-merge/packages/mcp/bin/cli.mjs:1153)

6. **Medium — Confirmed missing App setup gives the wrong next step without `gh`.** A user with a GitHub origin and a valid MegaLens credential gets the GitHub CLI installation error after the App status endpoint confirms the repo is unlinked. This was reproduced with no workflow. The App route explicitly supports users without `gh`, and the brief calls for the single App-or-workflow setup line here. Return that line and cover the missing-`gh` case. [No-`gh` selection](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:481) · [Existing setup fixture](/root/review-input/ws-plugin-app-path/tests/app-path.test.mjs:270)

7. **Medium — The App route can pick the wrong repository on GitHub Enterprise.** `gh repo view` provides the repository URL, but the plugin drops its host. The App then interprets the bare `owner/repo` and PR number against its GitHub.com installation. With the same repo name connected on GitHub.com, a user can pay for the cloud repo's different PR and see findings for the wrong code. The offline fixture confirmed App selection from an Enterprise URL. Validate and retain the host for App selection and bind PR discovery to that repository. [Repository discovery](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:393) · [PR discovery](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1213) · [Server PR lookup](/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:117) · [GitHub CLI host settings](https://cli.github.com/manual/gh_help_environment)

8. **Medium — A failed bookmark write leaves a started review without the promised resume path.** The App ignores the boolean returned by `saveLatest`. If the state directory is unwritable or rejected, the capped wait still says to run `/megalens:result`, which has no App job to look up. The offline fixture reproduced this with an invalid state path. Verify that a recoverable attempt can be saved before submitting, and handle a write failure after acceptance with an accurate recovery path. [Bookmark save](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1500) · [Write failures](/root/review-input/ws-plugin-app-path/scripts/lib/latest-review.mjs:67) · [No-ID lookup](/root/review-input/ws-plugin-app-path/scripts/engine.mjs:271)

9. **Medium — Transient polling failures end the inline wait and expose internal IDs.** The server can send `Retry-After: 60`, but the CLI waits at most five seconds, retries once and treats the second read failure as terminal. An offline fixture reproduced exit 4 after five seconds despite a 20-minute wait budget. The poll error contains the App UUID, and ordinary failed results also force internal IDs into no-flag output. Respect the backoff within the original deadline, keep waiting on retryable reads, and reserve IDs for explicit diagnostics. [Server rate limit](/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:62) · [Polling retry](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1510) · [Poll errors](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1145) · [Failed result rendering](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1117)

The supplied patch matched the commit diff. All 191 tests passed on Node 22 and the commit passed `git diff --check`. The tests exercise the plugin with fixtures for App presence and absence, credits, failure and basic timeout/resume. The billing findings above follow from the server source and offline fixtures. No production requests or charges were made.

I compared the prior commit with a temporary copy of the candidate with `APP_PATH_ENABLED=false`. The workflow, missing-workflow and missing-`gh` fixtures produced the same output, exit codes and subprocess calls, with zero App requests. The server's global-off and excluded-account paths return 404 before admission, and the plugin's authenticated-`gh` fixtures cover the 404 fallback. The normal App path sends target metadata and keeps a local bookmark, with result access scoped by the server to the caller and installation. The origin exception is finding 1.

VERDICT: FIX 9

## Fix round

Addressed all nine findings from `FIRST.md` (8 fixed in plugin code + tests in `/root/review-input/ws-plugin-app-path`; 1 confirmed as an external server-side launch gate in the reviewed API repo with client-side handling tested and gate documented).

1. **Finding 1 (High — Origin override could redirect the sign-in token) — Fixed.**
   - Pinned `resolveAppApiBase()` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) unconditionally to `https://megalens.ai` (`DEFAULT_APP_ORIGIN`), ignoring `MEGALENS_API_URL` and `MEGALENS_URL` from `env` so tracked `.claude/settings.json` project settings can never redirect the bearer token to another host. Updated [README.md](README.md).
   - Test: `tests/app-path.test.mjs` (`Token & URL security: origin pinned to https://megalens.ai...`) verifies `MEGALENS_API_URL` and `MEGALENS_URL` overrides send zero requests outside `https://megalens.ai`.

2. **Finding 2 (High — Lost PR reply could start a second billable job, PR head drift, `review_finishing`) — Fixed.**
   - `startAppReview` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) never auto-retries mutable PR submissions (`{ repo, tier, pr }`) after a lost/ambiguous reply: stops after 1 `POST`, warns not to start another review, and points to `https://github.com/<owner/repo>/pull/<pr>`. Bounded single retry remains only for immutable commit-SHA (`ref`) lost replies (and not 429).
   - `appReview` and `resolveMatchingAppBookmark` now verify `job.head_sha` against the local checkout SHA on every read: if the PR moved on GitHub (`job.head_sha !== pre.headSha`), the CLI corrects the saved bookmark to the server's actual `head_sha`, refuses to render wrong-head findings for the local commit, and exits 4 with a clear mismatch message.
   - `describeAppSubmitError` for `409 review_finishing` directs the user directly to the existing PR or commit URL on GitHub and warns not to rerun `/megalens:review` for the same commit.
   - Test: `tests/app-path.test.mjs` (`Finding 2: lost PR reply never retries into a second billable job, and PR head drift rejects wrong-head result and fixes bookmark`) plus updated `409 review_finishing` assertion.

3. **Finding 3 (High — App status outage could dispatch a second review through Actions) — Fixed.**
   - Added `resolveMatchingAppBookmark` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) and wired it into [scripts/engine.mjs](scripts/engine.mjs) **before** `detectRemoteRunner`: when a saved App bookmark matches `(repoKey, tier, localHeadSha)`, the CLI reads `GET /api/github-app/review-now/<id>` first, resuming in-flight jobs or rendering retained findings even during a `/api/github-app/status` 503 outage, and stops on non-404 read errors without dispatching Actions.
   - Updated `detectRemoteRunner` to require a definitive fallback signal (`unavailable_flag` 404 or `ok` with `!installed || !linked`) before checking or falling back to GitHub Actions; transient 503/502/429/network errors, 401, and suspended/notice-required linked repos never fall through to Actions. Layer 1 dedupe in `appReview` also stops on non-404 read errors instead of issuing a second `POST`.
   - Test: `tests/app-path.test.mjs` (`Finding 3: App status 503 outage resumes matching App bookmark and never falls back to dispatch Actions`).

4. **Finding 4 (High — Server early settlement with `ONE_PATH_V1` off) — External server launch gate (confirmed & documented; client-side `publish_failed` tested).**
   - Verified in the reviewed server source (outside this plugin repo, not modified here):
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:169` (`editorReviewNow` admits on-demand jobs when `GITHUB_APP_V1=on` without requiring `ONE_PATH_V1`).
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:374,408,435` (`prepare` sets `defer_complete` solely from `isOnePathEnabled()`).
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:599-614` (`resultHandler` settles `closeReview(job.reviewId, 'complete')` before GitHub publish and editor-result retention when `!deferSettlement`).
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:714-738` (permanent publish failure records `status: 'failed', reason: 'publish_failed'` with no `gh_review_editor_results` row and skips failure settlement when `!deferSettlement`, after `/root/review-input/ws-ondemand-merge/src/lib/engine-v2/service.ts:338` has already finalized the wallet charge/free review).
   - Because this workspace contains only the Claude Code plugin (no wallet/settlement code), documented this as a mandatory server release gate in [PLUGIN-NEEDS.md](PLUGIN-NEEDS.md) (item 14): do not enable `GITHUB_APP_V1=on` / ship this plugin release until the server enforces deferred settlement for all editor jobs (including `shared`/reused jobs) regardless of `ONE_PATH_V1`, with server tests covering permanent publish failure for both paid and free Standard admissions with `ONE_PATH_V1` off.
   - Client-side test: `tests/app-path.test.mjs` verifies `status: 'failed', reason: 'publish_failed', findings: null` exits 4, reports `FAILED` ("MegaLens could not publish the review result to GitHub. This is not a clean review."), hides internal IDs in no-flag mode, and does not falsely claim nothing was charged.

5. **Finding 5 (Medium — Browser sign-in left `/megalens:review` disconnected) — Fixed.**
   - Added `resolveClaudeMcpConfigPath` and `readClaudeMcpToken` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) and wired them into `extractAppToken`: when `MEGALENS_TOKEN` is unset in the shell, reads Claude Code's trusted user-scoped `.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` for absolute `CLAUDE_CONFIG_DIR`, else `$HOME/.claude.json`, never project `.mcp.json` or relative paths), validates `mcpServers.megalens.url` has origin `https://megalens.ai`, and extracts the `Authorization: Bearer ml_tok_...` token with exact+regex scrubbing. Updated [README.md](README.md).
   - Test: `tests/app-path.test.mjs` (`Finding 5: browser sign-in credential in user ~/.claude.json connects /megalens:review with empty shell env`).

6. **Finding 6 (Medium — Missing `gh` gave the wrong setup instruction after confirmed unlinked App) — Fixed.**
   - In `detectRemoteRunner` ([scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs)), when `gh` is unavailable/unauthenticated and `git remote origin` is a `github.com` repo whose `GET /api/github-app/status` confirms `installed: false` / `linked: false` (`state === 'ok'`), return the single setup line (`Install the MegaLens GitHub App or add the workflow: https://megalens.ai/app/start`) instead of falling through to the `gh` install error.
   - Test: `tests/app-path.test.mjs` (`Finding 6: confirmed missing App setup without gh prints the App-or-workflow setup line (not gh install error)`).

7. **Finding 7 (Medium — GitHub Enterprise could select the `github.com` App and PR discovery was unbound) — Fixed.**
   - `ghRepoPreflight` now parses and validates `repo.url` (and `GH_HOST`), setting `host` and `isGithubCom` (`https://github.com/<nwo>` only). `detectRemoteRunner` skips the App path completely for non-`github.com` repos (falling back to Actions workflow if present or printing a clear Enterprise message), and `appPreflight` rejects non-`github.com` repos on `--runner app` and pins `gh api --hostname github.com`.
   - `detectOpenPr` now resolves the checked-out branch, passes `-R github.com/<nwo>` and `--json ...,url` to `gh pr view`, and verifies `pr.url` matches `https://github.com/<nwo>/pull/<number>`.
   - Test: `tests/app-path.test.mjs` (`Finding 7: GitHub Enterprise never selects the github.com App and PR discovery is bound to github.com/<nwo>`).

8. **Finding 8 (Medium — Failed bookmark write broke promised `/megalens:result` resume) — Fixed.**
   - Added `canSaveLatestReview` in [scripts/lib/latest-review.mjs](scripts/lib/latest-review.mjs) to verify symlink-safety and writability before `appReview` calls `startAppReview` (stopping with exit 4 and zero `POST` if unwritable/symlinked).
   - Added `stillRunningLine` to `waitForReview` ([scripts/lib/wait-loop.mjs](scripts/lib/wait-loop.mjs)) and checked `saveLatest(...)` return value in `appReview`: if a write fails after server acceptance, `--no-wait`, capped/aborted wait, and terminal poll errors give the explicit `/megalens:result app:<uuid>` recovery command instead of a broken no-ID prompt.
   - Test: `tests/app-path.test.mjs` (`Finding 8: unwritable/symlinked state dir stops before POST, and post-acceptance save failure gives explicit ID recovery path`).

9. **Finding 9 (Medium — Transient polling errors ended the wait early and exposed internal IDs) — Fixed.**
   - Added non-terminal `state: 'retry'` with `retryAfterMs` support in [scripts/lib/wait-loop.mjs](scripts/lib/wait-loop.mjs). `appReview` now honours `Retry-After` (e.g. 60s on `429 rate_limited`) and exponential backoff on transient `5xx`/network reads across the full 20-minute wait budget instead of exiting after 5s/2 failures.
   - `fetchAppJob`, `appStatus`, `appResult`, `renderAppJob`, and `renderResult` ([scripts/lib/engine-core.mjs](scripts/lib/engine-core.mjs)) now reserve `app:<uuid>` and failed-result `rv_...` IDs for explicit diagnostic calls (`showId: true`), hiding them from no-flag poll errors and ordinary failed results while preserving earlier `SOL-9` partial-result coverage.
   - Test: `tests/app-path.test.mjs` (`Finding 9: retryable polling respects Retry-After: 60 within 20-min cap, keeps waiting across transient errors, and hides internal IDs in no-flag output`).

### Verification

- Ran `npm test && git diff --check`: **197 / 197 tests passed** (0 failed, 0 skipped), zero whitespace/patch errors.


## Fix round (LOOP-CONFIRM1)

Addressed every open/new finding from `/root/review-input/rv-plugin-app-path/LOOP-CONFIRM1.md` (5 fixed in plugin code + tests in `/root/review-input/ws-plugin-app-path`; #4 confirmed as an external server-side launch gate outside this plugin workspace with `file:line` evidence):

1. **NEW High — `/megalens:review` could report a clean result for the wrong PR — Fixed.**
   - `resolveMatchingAppBookmark` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) now discovers the repository (`ghRepoPreflight` / `gitRepoFallback`), validates `repo.isGithubCom` and `saved.nwo === repo.nwo`, and resolves the current open PR via `detectOpenPr` (`gh pr view`) **before** ever reading or reusing a saved App bookmark. When `(saved.prNumber ?? null) !== (currentPrNumber ?? null)` (e.g. switching from PR #41 to PR #42 at the exact same commit SHA, or switching between a PR and a non-PR ref), bookmark reuse is skipped and the requested target is reviewed. Both `resolveMatchingAppBookmark` and `appReview` Layer 1 dedupe also verify `jobMatchesTargetPr(job, nwo, prNumber)` against `job.pr_url`.
   - Test: `tests/app-path.test.mjs` (`LOOP-CONFIRM1 NEW High + #7 + #9 + #2`) switches from PR #41 (clean) to PR #42 (finding) at the same SHA and verifies `gh pr view` runs, `{ repo, tier, pr: 42 }` is submitted, and PR #42's finding is returned.

2. **Finding #7 (Medium — Reopened by LOOPFIX1: Enterprise checkout reused saved `github.com` job before host discovery) — Fixed.**
   - `resolveMatchingAppBookmark` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) runs `ghRepoPreflight` (and `gitRepoFallback` when `gh` is unavailable) **before** touching any saved `github.com` App job. If `!repo.isGithubCom` (e.g. host switched to `github.enterprise.example` or `GH_HOST` is non-`github.com`), it immediately returns `{ action: 'continue', preRepo }` with zero App API calls, and [scripts/engine.mjs](scripts/engine.mjs) passes `preRepo` into `detectRemoteRunner`.
   - Test: `tests/app-path.test.mjs` (`LOOP-CONFIRM1 NEW High + #7 + #9 + #2`) moves the same checkout to `github.enterprise.example` after a `github.com` App review and asserts `gh repo view` runs, zero requests reach `https://megalens.ai`, and the Enterprise message is printed.

3. **Finding #2 (High — Moved PR with `--no-wait` rendered wrong-head findings on no-ID `/megalens:result` / `/megalens:status`) — Fixed.**
   - Added `requestedHeadSha` routing metadata in [scripts/lib/latest-review.mjs](scripts/lib/latest-review.mjs) and `checkBookmarkHeadDrift` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs), wired into no-ID `appResult` and `appStatus` from [scripts/engine.mjs](scripts/engine.mjs). When the server reviewed a moved head (`job.head_sha !== saved.headSha` or previously drifted `saved.requestedHeadSha`) and the local checkout (`HEAD`) is not at `job.head_sha`, no-ID `/megalens:result` and `/megalens:status` update the bookmark to record the actual `headSha` (retaining `requestedHeadSha`), refuse to render wrong-head findings, and exit 4 with the head-mismatch message. Once the user runs `git pull` so local `HEAD === job.head_sha`, no-ID `/megalens:result` clears `requestedHeadSha` and renders the findings cleanly (exit 0).
   - Also updated `resolveMatchingAppBookmark` and `appReview` Layer 1 dedupe so re-running `/megalens:review` after `--no-wait` on a moved PR stops immediately with head mismatch (exit 4) instead of falling through to submit a second `POST`.
   - Test: `tests/app-path.test.mjs` (`LOOP-CONFIRM1 NEW High + #7 + #9 + #2`) covers `review --no-wait` on a moved PR followed by direct no-ID `result`, repeated `result`/`status` before `git pull`, `review` rerun (zero second `POST`), and `result` after `git pull`.

4. **Finding #5 (Medium — Relative `CLAUDE_CONFIG_DIR` resolved differently from `@megalens/mcp` browser setup) — Fixed.**
   - Updated `resolveClaudeMcpConfigPath` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) to resolve any non-placeholder `CLAUDE_CONFIG_DIR` via `path.join(path.resolve(custom), '.claude.json')`, matching `/root/review-input/ws-ondemand-merge/packages/mcp/bin/host-setup.mjs:62-65` identically while still enforcing `https://megalens.ai` origin pinning on both the MCP entry URL and all App API calls.
   - Test: `tests/app-path.test.mjs` (`Finding 5: ...`) verifies `resolveClaudeMcpConfigPath({ HOME, CLAUDE_CONFIG_DIR: './claude-profile' })` equals `path.join(path.resolve('./claude-profile'), '.claude.json')` and runs an end-to-end App review using a relative `CLAUDE_CONFIG_DIR` with an empty shell `MEGALENS_TOKEN`.

5. **Finding #9 (Medium — First read of a saved job with `Retry-After: 60` / transient error exited 4 without waiting) — Fixed.**
   - Added `fetchAppJobWithRetry` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) and wired it into both `resolveMatchingAppBookmark` and `appReview` Layer 1 dedupe, passing `wait`, `waitMs`, `pollMs`, `now`, `t0`, and `sleep` from [scripts/engine.mjs](scripts/engine.mjs). Retryable reads (`429 rate_limited` with `Retry-After: 60`, `5xx`, network errors) now sleep and retry across the full `waitMs` budget (carrying `initialSleptMs` into `waitForReview` in [scripts/lib/wait-loop.mjs](scripts/lib/wait-loop.mjs), which also tracks accumulated `sleptMs` so fixtures that mock `sleep` without mocking `now` cap cleanly at `waitMs`), never falling back to Actions or exposing internal IDs.
   - Test: `tests/app-path.test.mjs` (`Finding 3c` and `LOOP-CONFIRM1 NEW High + #7 + #9 + #2`) verifies both recovery after `429 Retry-After: 60` (sleeping 60s with zero second `POST`) and full-budget waiting on persistent `429`/`503` (including mock-`sleep`-only fixtures).

6. **Finding #4 (High — Server early settlement when `ONE_PATH_V1` is off) — Blocked outside this plugin workspace (server-side launch gate).**
   - This workspace (`/root/review-input/ws-plugin-app-path`) contains only the Claude Code plugin; wallet hold/finalization and worker publish settlement live exclusively in the separate MegaLens server repository (`/root/review-input/ws-ondemand-merge`), which cannot be modified from this plugin-only workspace:
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:169-203` (`editorReviewNow` admits on-demand editor jobs under `GITHUB_APP_V1=on` without requiring `ONE_PATH_V1`).
     - `/root/review-input/ws-ondemand-merge/supabase/migrations/20261123230000_github_app_on_demand.sql:137-142` (`shared` reuse attaches editor requests to in-flight jobs).
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:374,408,435` (`prepare` sets `defer_complete` solely from `isOnePathEnabled()`).
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:599-614,714-738` (when `!deferSettlement`, `resultHandler` calls `closeReview(job.reviewId, 'complete')` before GitHub publish and editor-result retention, so a permanent publish error marks the job `failed`/`publish_failed` with no editor findings after `/root/review-input/ws-ondemand-merge/src/lib/engine-v2/service.ts:338-347` has finalized the charge/free review).
   - Remains documented as a mandatory server release gate in [PLUGIN-NEEDS.md](PLUGIN-NEEDS.md) (item 14), with client-side `publish_failed` failure handling tested in `tests/app-path.test.mjs`.

### Verification

- Ran `npm test && git diff --check`: **198 / 198 tests passed** (0 failed, 0 skipped), zero whitespace/patch errors.


## Fix round (LOOP-CONFIRM2)

Addressed every open/new finding from `/root/review-input/rv-plugin-app-path/LOOP-CONFIRM2.md` (4 fixed in plugin code + tests in `/root/review-input/ws-plugin-app-path`; #4 confirmed as an external server-side launch gate outside this plugin-only workspace with `file:line` evidence):

1. **Finding #2 (High — Moved PR: `--no-wait` -> no-ID `result` -> `/megalens:review` rerun fell back to a second billable commit-only `{ ref }` POST) — Fixed.**
   - `detectOpenPr` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) now returns a structured state (`open`, `none`, `head_mismatch`, `error`, `aborted`) instead of silently returning `null` when an open, non-draft, same-repo PR exists on the current branch at a different `headRefOid`.
   - `resolveMatchingAppBookmark` now matches bookmarks on both `saved.headSha` and `saved.requestedHeadSha`, and when `detectOpenPr` reports `head_mismatch` for the moved PR (including after no-ID `/megalens:result` updated `headSha` to the moved SHA and stored the local SHA in `requestedHeadSha`), it stops with exit 4 (`describeHeadMismatch` / `describePrHeadBehind`) and makes zero second `POST`. `appPreflight` also fails closed on `head_mismatch` so explicit `--runner app` or different-tier reruns never silently narrow a moved PR to a single-commit `{ ref }` submission.
   - Test: `tests/app-path.test.mjs` (`LOOP-CONFIRM2: ...`) runs `review --no-wait` (PR moves at submit) -> no-ID `result` (exit 4) -> `review` rerun (asserts exit 4, zero second `POST`, no `{ ref }` fallback) -> `--runner app` (zero second `POST`) -> `result` after `git pull` (exit 0).

2. **Finding #7 (Medium — Enterprise checkout on no-ID `/megalens:result` and `/megalens:status` still read a saved `github.com` App bookmark) — Fixed.**
   - Added `verifyAppBookmarkRepo` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) (also guarding `GH_HOST` in `gitRepoFallback`) and wired it into no-ID `status` / `result` in [scripts/engine.mjs](scripts/engine.mjs) before `pickNewerReview` or any App API call. When the current checkout is on GitHub Enterprise (or a different repo), the stale `github.com` App bookmark is ignored, zero requests reach `https://megalens.ai`, and no-ID `status`/`result` returns exit 4 (or shows a real Enterprise workflow run if present).
   - Test: `tests/app-path.test.mjs` (`LOOP-CONFIRM2: ...`) starts an App review on `github.com`, moves the checkout to `github.enterprise.example` (both with `gh` and via no-`gh` Enterprise remote), and asserts no-ID `result` and `status` exit 4 with zero reads to `https://megalens.ai`.

3. **NEW High — Retargeting an open PR returned a stale clean result — Fixed.**
   - `detectOpenPr` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) now requests `baseRefOid,baseRefName` from `gh pr view`, [scripts/lib/latest-review.mjs](scripts/lib/latest-review.mjs) persists validated `prBaseSha` and `prBaseRef` alongside `prNumber`, and `bookmarkMatchesPrBase` is enforced in both `resolveMatchingAppBookmark` and `appReview` Layer 1 dedupe (and preserved across head-drift bookmark updates). When an open PR's base commit SHA or base branch changes while its head SHA stays identical, `/megalens:review` (default and `--runner app`) skips the stale bookmark and submits a fresh PR review for the new diff.
   - Test: `tests/app-path.test.mjs` (`LOOP-CONFIRM2: ...`) completes a clean PR review at base `B1`, retargets `baseRefOid` to `B2` (and separately `baseRefName` to `release`) with the same head `A`, and verifies `/megalens:review` submits a fresh `{ repo, tier, pr: 41 }` review and surfaces the new diff's finding (while still reusing the bookmark when the base is unchanged).

4. **NEW High — A PR lookup outage (`gh pr view` HTTP 502) silently narrowed a paid review to one commit — Fixed.**
   - `detectOpenPr` in [scripts/lib/gh-runner.mjs](scripts/lib/gh-runner.mjs) now distinguishes a definitive "no pull request" response (`no pull requests? found|could not resolve to a pullrequest`) and detached `HEAD` from transient/unexpected failures (`GraphQL: HTTP 502`, network/auth errors, malformed JSON, or failed `git branch`). Any non-definitive lookup failure returns `{ state: 'error' }`, causing both `resolveMatchingAppBookmark` and `appPreflight` to fail closed with exit 4 ("Nothing was started and no credit was used") and zero `POST` requests.
   - Test: `tests/app-path.test.mjs` (`LOOP-CONFIRM2: ...`) makes `gh pr view` return `GraphQL: HTTP 502` while the commit lookup succeeds (both with no bookmark and with an existing bookmark) and verifies exit 4, zero `POST` requests, and zero stale bookmark reads.

5. **Finding #4 (High — Server early settlement when `ONE_PATH_V1` is off) — External server-side launch gate (unreachable from this plugin-only workspace).**
   - This workspace (`/root/review-input/ws-plugin-app-path`) contains only the Claude Code plugin; wallet hold/finalization and worker settlement live exclusively in the separate MegaLens server repository (`/root/review-input/ws-ondemand-merge`, outside our allowed working tree), and `GET /api/github-app/status` (`on-demand.ts:85-90`) does not expose `ONE_PATH_V1` or `defer_complete` to clients:
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:85-90,169-203` (`editorReviewNow` admits on-demand jobs whenever `GITHUB_APP_V1=on` without requiring `ONE_PATH_V1`; `editorStatus` returns only `{ installed, linked, notice_accepted, suspended }`).
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:374,408,435` (`prepare` sets `defer_complete` solely from `isOnePathEnabled()`).
     - `/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:599-614,714-738` (when `!deferSettlement`, `resultHandler` settles `closeReview(job.reviewId, closeStatus)` before GitHub publish and editor-result retention, so a permanent publish error marks the job `failed`/`publish_failed` with no editor findings after `/root/review-input/ws-ondemand-merge/src/lib/engine-v2/service.ts:338-347` has finalized the charge/free review).
   - Remains documented as a mandatory server release gate in [PLUGIN-NEEDS.md](PLUGIN-NEEDS.md) (item 14), with client-side `publish_failed` handling tested in `tests/app-path.test.mjs`.

### Verification

- Ran `npm test && git diff --check`: **199 / 199 tests passed** (0 failed, 0 skipped), zero whitespace/patch errors.

## Fix round

Fixed both plugin findings in [LOOP-CONFIRM3.md](/root/review-input/rv-plugin-app-path/LOOP-CONFIRM3.md) after reading the four reviews in chronological order.

- **Upstream branch.** `/megalens:review` uses the configured upstream branch name when looking for the PR in the selected GitHub repository. The regression test covers a renamed upstream with a slash in its name and a numeric upstream. Both submit the PR number and display the PR findings. [PR selection](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1421) · [Test](/root/review-input/ws-plugin-app-path/tests/app-path.test.mjs:302)
- **Repository lookup fallback.** When authenticated `gh repo view` fails, a GitHub.com `origin` supplies the repository and `gh` still verifies the commit and looks up the PR. The test covers automatic and explicit App selection, bookmark reuse, and an Enterprise origin. [Repository fallback](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:472) · [Test](/root/review-input/ws-plugin-app-path/tests/app-path.test.mjs:324)
- **PR lookup failures.** An inconclusive lookup exits with code 4, names the branch and reports the lookup error. The test exercises a 502 after repository fallback with and without a saved review and checks for zero review submissions or saved-result reads. [Error handling](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1457) · [Test](/root/review-input/ws-plugin-app-path/tests/app-path.test.mjs:348)
- **PR bookmark base SHA.** New PR bookmarks store a validated `prBaseSha`. Missing or malformed base metadata stops the review before submission. A legacy bookmark without a base SHA triggers a fresh PR review once GitHub returns a valid base, and reuse requires a matching SHA. Both App runner modes are covered, along with the existing retargeting regression. [Base validation](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1494) · [Bookmark matching](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:1401) · [Bookmark save](/root/review-input/ws-plugin-app-path/scripts/lib/gh-runner.mjs:2158) · [Test](/root/review-input/ws-plugin-app-path/tests/app-path.test.mjs:372)

### Server track

- **FIRST #4.** Worker settlement before delivery when `ONE_PATH_V1` is off. [worker-api.ts:599](/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:599)
- **LOOP-CONFIRM2 new high #1.** Server PR target resolution and queue deduplication after the PR base changes. [on-demand.ts:117](/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:117) · [20261123230000_github_app_on_demand.sql:113](/root/review-input/ws-ondemand-merge/supabase/migrations/20261123230000_github_app_on_demand.sql:113)

### Verification

- `npm test` passed all 203 tests. All four new regression tests failed against the pre-fix runner and passed with the fix.
- `git diff --check` passed. The plugin tests required no Postgres instance.

## Fix round

Fixed both open plugin findings from the latest review after reading the earlier rounds in chronological order. [LOOP-CONFIRM1.md](/root/review-input/rv-plugin-app-path/LOOP-CONFIRM1.md)

1. **High — A branch tracking its base skipped its own PR.** The App checks the upstream branch when its remote resolves to the selected GitHub repository. If that branch has no eligible open PR, it checks the local branch name. An upstream in a different repository goes directly to the local branch lookup. The regression covers both cases in automatic and explicit App mode, checks that the submission uses the PR number, and verifies that the bookmark includes the base SHA. The renamed and numeric upstream cases still pass. [PR selection](scripts/lib/gh-runner.mjs#L1421) · [Regression](tests/app-path.test.mjs#L330)
2. **High — Auth-status failure disabled PR discovery on repository fallback.** A validated GitHub.com origin can supply the repository after a `gh auth status` or `gh repo view` failure. When `gh` is installed, the App still queries the PR in that repository. An inconclusive lookup exits 4, identifies the branch and error, and stops before a review submission or a saved-result read. Tests cover an auth-status error with working PR lookup, a 502 after auth failure, and a 502 on the local lookup after the upstream has no PR. [Repository fallback](scripts/lib/gh-runner.mjs#L473) · [Lookup error handling](scripts/lib/gh-runner.mjs#L1477) · [Auth regression](tests/app-path.test.mjs#L392) · [Lookup regression](tests/app-path.test.mjs#L419)

PR bookmarks continue to require a valid base SHA for reuse. The retained regression exercises missing or invalid GitHub base metadata and refreshes a legacy bookmark once it receives a valid base SHA. [Base validation](scripts/lib/gh-runner.mjs#L1513) · [Bookmark match](scripts/lib/gh-runner.mjs#L1401) · [Regression](tests/app-path.test.mjs#L456)

### Server track

- **FIRST #4.** Early credit or free-review settlement before delivery when `ONE_PATH_V1` is off. [worker-api.ts:599](/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:599)
- **LOOP-CONFIRM2 new high #1.** Server target resolution and queue deduplication after a PR base change. [on-demand.ts:117](/root/review-input/ws-ondemand-merge/src/lib/github-setup/on-demand.ts:117) · [20261123230000_github_app_on_demand.sql:113](/root/review-input/ws-ondemand-merge/supabase/migrations/20261123230000_github_app_on_demand.sql:113)

### Verification

- Both new regressions failed against the prior runner and passed with the fix.
- `npm test` passed all 205 tests. `git diff --check` passed. The suite required no Postgres instance.

## Fix round

The signed-out CLI case was the only plugin finding still open in the latest confirmation. [LOOP-CONFIRM2.md](/root/review-input/rv-plugin-app-path/LOOP-CONFIRM2.md)

- **High — App review with `gh` signed out.** The plugin recognizes GitHub CLI’s explicit signed-out response and uses the existing App-only path. It resolves the repository from the GitHub.com origin and submits the checked-out commit SHA. Other preflight errors still allow PR discovery, and an inconclusive PR lookup stops before submission. The new regression covers automatic and explicit App selection on a branch and detached HEAD, with one App submission and zero authenticated `gh` calls in each case. It failed against the prior runner. The existing GitHub 502 regressions pass with the fix. [Auth detection](scripts/lib/gh-runner.mjs#L443) · [Regression](tests/app-path.test.mjs#L297) · [Outage regressions](tests/app-path.test.mjs#L422)

### Server track

Exclude both findings from the plugin confirmation count. They belong to `ondemand-server-fix`.

- **FIRST #4.** Worker settlement before delivery when `ONE_PATH_V1` is off. [worker-api.ts:599](/root/review-input/ws-ondemand-merge/src/lib/github-setup/worker-api.ts:599)
- **Earlier LOOP-CONFIRM2 new high #1.** On-demand queue matching after a PR base change. [20261123230000_github_app_on_demand.sql:113](/root/review-input/ws-ondemand-merge/supabase/migrations/20261123230000_github_app_on_demand.sql:113)

### Verification

`npm test` passed all 206 tests. `git diff --check` passed. The suite ran with disposable fixtures inside the workspace and required no Postgres instance.
