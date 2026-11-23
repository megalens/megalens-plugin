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
