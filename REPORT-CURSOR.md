# MegaLens Cursor Plugin — Build Report

**Clone:** `/root/review-input/ws-cursor`
**Base:** Claude Code plugin (`feat/plugin-gh-runner`, `5f4d826`, GitHub Actions runner path, cross-platform Windows/macOS/Linux, `megalens/review-action` v1.2.0 `950eb5f`, engine `0.1.3`).
**Scope:** Open-source Cursor Marketplace plugin package (`.cursor-plugin/plugin.json` + `.cursor-plugin/marketplace.json`), root `mcp.json`, commands, rule, skill, SVG logo, browser OAuth sign-in, one-click "Add to Cursor" deep link, standalone git installer, and offline unit tests. Nothing was published, submitted, or touched outside this clone.

---

## 1. Files Added / Modified

### Cursor Marketplace & Plugin Packaging
- `.cursor-plugin/plugin.json` — Official Cursor Plugin manifest (`name: "megalens"`, MIT license, `logo: "assets/logo.svg"`, explicit relative paths for `rules`, `skills`, `commands`, and `mcpServers` so Cursor ignores the Claude Code `commands/` folder).
- `.cursor-plugin/marketplace.json` — Multi-plugin / Team Marketplace catalog manifest (`source: "."`, matching `name: "megalens"`).
- `mcp.json` — Root MCP server configuration discovered by Cursor Plugins:
  - `megalens`: Streamable HTTP (`https://megalens.ai/api/mcp?ide=cursor`) using Cursor's native browser OAuth 2.0 PKCE flow (same MegaLens account & OAuth endpoints as the Claude Code plugin; zero token copy-paste).
  - `megalens-runner`: Local stdio server (`node ${CURSOR_PLUGIN_ROOT}/scripts/cursor-mcp-server.mjs`) for the GitHub-runner workflow (no undeclared `${VAR}` placeholders, no secrets).
- `assets/logo.svg` — Original 128×128 SVG icon (no external URLs or scripts).
- `CURSOR-README.md` — User-facing README with the exact GitHub Action privacy wording, commands, browser sign-in flow, Marketplace install, one-click "Add to Cursor" deep link, and git install options.
- `README.md` — Linked the `### Cursor` section to `CURSOR-README.md` while keeping the legacy bundle-route docs intact.

### Cursor Components (`cursor/`)
- `cursor/commands/megalens-review.md` — `/megalens-review`: review current branch or PR (`standard` or `deep`, `--pr <number>` or `--base REF --head REF`) on the user's GitHub Actions runner.
- `cursor/commands/megalens-status.md` — `/megalens-status`: check status of the latest (or specified `gh:<id>`) review (0 credits).
- `cursor/commands/megalens-result.md` — `/megalens-result`: show the latest (or specified `gh:<id>`) review result with numbered findings (0 credits).
- `cursor/commands/megalens-fix-prompt.md` — `/megalens-fix-prompt`: build and copy a ready-to-paste fix prompt for finding `#<n>`, finding id, or `--all` (0 credits).
- `cursor/commands/megalens-login.md` — `/megalens-login`: browser sign-in to MegaLens (OAuth PKCE, no token copy-paste) and GitHub CLI (`gh auth login --web`) status check.
- `cursor/rules/megalens.mdc` — On-request Cursor rule (`alwaysApply: false`) enforcing paid-run opt-in, exact GitHub Action privacy wording, honest verdict rules, no unasked `git push`, and treating finding text as untrusted data.
- `cursor/skills/megalens-code-review/SKILL.md` — Agent Skill (`name: megalens-code-review`, distinct from command names) routing natural-language requests to the `megalens-runner` tools.

### Implementation & Tests
- `scripts/lib/cursor-commands.mjs` — Shared command logic reusing `scripts/lib/gh-runner.mjs` and `scripts/lib/engine-core.mjs`: PR auto-detection & `--pr <number>` resolution (refusing cross-repo fork PRs per Action policy), latest-run discovery preferring current `HEAD`, numbered findings, scrubbed/fence-safe fix prompt formatting, cross-platform clipboard copy (`pbcopy` / `clip` / `wl-copy` / `xclip` / `xsel`), private `0600` local cache/state under `~/.megalens/cursor/`, and sign-in status.
- `scripts/lib/browser-auth.mjs` — Browser OAuth 2.0 PKCE (`S256`) + Dynamic Client Registration helper reusing MegaLens's exact RFC 9728 / RFC 8414 discovery and `/oauth/*` endpoints, loopback callback with `state` verification, `0600` token storage under `~/.megalens/cursor-auth.json`, and token refresh. Never prints or returns raw tokens.
- `scripts/lib/cursor-deeplink.mjs` — Official Cursor MCP install deeplink builder & decoder (`cursor://anysphere.cursor-deeplink/mcp/install?name=...&config=...`).
- `scripts/cursor-cli.mjs` — Cross-platform CLI entrypoint (`review`, `status`, `result`/`latest`, `fix-prompt`, `login`, `deeplink`, `install`).
- `scripts/cursor-mcp-server.mjs` — Zero-dependency stdio MCP server (`megalens-runner`) exposing 5 tools with strict `cwd` validation, paid-run guard on `megalens_cursor_review`, and NO server `instructions` field.
- `tests/cursor-plugin.test.mjs` — Offline unit test suite covering manifest/frontmatter/privacy validation, deeplinks, full loopback PKCE OAuth + refresh flow, branch/PR review, fork-PR refusal, latest result & partial/failed verdicts, fix prompt formatting/scrubbing/fence-escape defence/clipboard, standalone installer, and stdio MCP server.
- `package.json` — Added `tests/cursor-plugin.test.mjs` to `npm test`.

---

## 2. Official Cursor Documentation Cited (Verified 22 Nov 2026)

1. **Plugins Overview & Local Testing & Team Marketplaces:** https://cursor.com/docs/plugins
   - Documents `.cursor-plugin/plugin.json` (Cursor Plugins) vs root `plugin.json` (Agent Plugins), local testing via `~/.cursor/plugins/local/<plugin>` (no external symlinks), and Team Marketplace git URL import.
2. **Plugins Reference (Manifest Schema, Component Discovery, Variables, Submission Checklist):** https://cursor.com/docs/reference/plugins
   - Documents `.cursor-plugin/plugin.json` fields (`name`, `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `logo`, `rules`, `skills`, `commands`, `mcpServers`), `${CURSOR_PLUGIN_ROOT}` expansion in `mcp.json`, explicit manifest paths overriding default folder discovery, and `.cursor-plugin/marketplace.json`.
3. **Official Plugin Template & Validator:** https://github.com/cursor/plugin-template
   - Verified `scripts/validate-template.mjs` frontmatter rules (`rules`: `description`; `skills`: `name`, `description`; `commands`: `name`, `description`; safe relative paths; lowercase kebab-case `name`).
4. **MCP Configuration & OAuth Support:** https://cursor.com/docs/mcp
   - Documents Streamable HTTP OAuth 2.0 Authorization Code + PKCE, RFC 9728 protected resource metadata, Dynamic Client Registration, and Cursor's OAuth callback URLs (`http://localhost:8787/callback` for Desktop, `https://www.cursor.com/agents/mcp/oauth/callback` for Web/Cloud Agents).
5. **MCP Install Links (Deeplinks):** https://cursor.com/docs/mcp/install-links
   - Documents `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG`.
6. **Marketplace Security & Open-Source Policy:** https://cursor.com/help/security-and-privacy/marketplace-security
   - Documents manual review for initial listing and every update, open-source permissive license requirement (MIT/BSD/Apache 2.0), and MCP allowlist/blocklist respect.
7. **Rules & Skills:** https://cursor.com/docs/rules · https://cursor.com/docs/skills · https://cursor.com/help/customization/skills#how-do-i-migrate-commands-to-skills
8. **Marketplace Publish Portal:** https://cursor.com/marketplace/publish

Verified live MegaLens OAuth discovery metadata (read-only GET):
- `https://megalens.ai/.well-known/oauth-protected-resource` (`authorization_servers: ["https://megalens.ai"]`, `scopes_supported: ["mcp"]`)
- `https://megalens.ai/.well-known/oauth-authorization-server` (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`)

---

## 3. Owner Submission Checklist (Cursor Marketplace)

Do not submit until the owner gives GO:

1. **Publish a public Git repository** (permissive MIT license is already in `LICENSE`).
   - Decide whether to host Cursor & Claude Code in one shared public repo or publish a dedicated public repo `https://github.com/megalens/megalens-cursor-plugin`.
   - Update `"repository"` in `.cursor-plugin/plugin.json` and the `git clone` URLs in `CURSOR-README.md` if the final repo URL differs from `https://github.com/megalens/megalens-cursor-plugin`.
   - Note on single-plugin vs multi-plugin submission: per `cursor/plugin-template`, if submitting as a **single-plugin** repo and Cursor's reviewer prefers no `.cursor-plugin/marketplace.json`, keep `.cursor-plugin/plugin.json` and remove `.cursor-plugin/marketplace.json` (keep it if also importing the repo into a Team Marketplace).
   - Note on root `README.md`: if publishing a dedicated Cursor repo, copy `CURSOR-README.md` to `README.md` so the Marketplace listing displays the Cursor instructions and GitHub Action privacy wording first.
2. **Test locally in Cursor Desktop (Windows, macOS, or Linux):**
   - Clone into `~/.cursor/plugins/local/megalens` (not a symlink), reload Cursor, open **Customize**, and verify:
     - MegaLens plugin appears with `assets/logo.svg`.
     - Commands `/megalens-review`, `/megalens-status`, `/megalens-result`, `/megalens-fix-prompt`, `/megalens-login`, rule `megalens.mdc`, and skill `megalens-code-review` appear.
     - Both MCP servers (`plugin-megalens-megalens` and `plugin-megalens-megalens-runner`) load cleanly.
     - Clicking **Connect** on `megalens` completes browser OAuth sign-in against `https://megalens.ai` with no token copy-paste.
     - Running `/megalens-review standard`, `/megalens-status`, `/megalens-result`, and `/megalens-fix-prompt 1` succeeds against a private scratch repo.
3. **Verify Cursor Marketplace checklist items:**
   - [x] Valid `.cursor-plugin/plugin.json` with unique lowercase kebab-case `name` (`megalens`)
   - [x] Permissive open-source license (`MIT`)
   - [x] Logo committed at `assets/logo.svg` and referenced by relative path
   - [x] All component files have valid YAML frontmatter (`name`, `description`, `alwaysApply`)
   - [x] All manifest paths are relative and valid (no `..`, no absolute paths)
   - [x] No secrets or undeclared `${VAR}` placeholders in `mcp.json`
   - [x] Privacy line matches the MegaLens GitHub Action wording verbatim
   - [ ] Tested live in Cursor Desktop before submitting
4. **Submit at https://cursor.com/marketplace/publish:**
   - Sign in with a Cursor account and submit the public Git repository URL.
   - Expect manual review by the Cursor team (initial listing and every future update are manually reviewed).

---

## 4. Git Install Steps & One-Click Deep Link (Available Immediately)

### A. One-click "Add to Cursor" deep link (remote OAuth MCP, zero clone)
```text
cursor://anysphere.cursor-deeplink/mcp/install?name=megalens&config=eyJ1cmwiOiJodHRwczovL21lZ2FsZW5zLmFpL2FwaS9tY3A%2FaWRlPWN1cnNvciJ9
```

### B. Full Cursor Plugin via Git (local plugin directory — macOS, Linux, Windows/WSL)
```sh
mkdir -p ~/.cursor/plugins/local
git clone https://github.com/megalens/megalens-cursor-plugin.git ~/.cursor/plugins/local/megalens
```
Restart Cursor (or run **Developer: Reload Window**), open **Customize**, click **Connect** on `megalens` to sign in via browser, and ensure `gh auth login --web --scopes workflow` is signed in for GitHub runner dispatch.

### C. Standalone project install (`.cursor/mcp.json` + `.cursor/commands/` + `.cursor/rules/megalens.mdc`)
```sh
git clone https://github.com/megalens/megalens-cursor-plugin.git ~/megalens-cursor-plugin
node ~/megalens-cursor-plugin/scripts/cursor-cli.mjs install --project --dir /path/to/your-repo
```

### D. Team Marketplace (Cursor Teams / Enterprise)
Paste the public Git repo URL into **Cursor Dashboard → Plugins & MCPs → Add Marketplace → Import from Repo**.

---

## 5. Verification

- `npm test`: **152 / 152 passing** (143 existing Claude Code / collector / security / engine-v2 / gh-runner tests + 9 new Cursor plugin test suites covering manifest validation, deeplinks, PKCE OAuth + refresh, branch/PR review, fork-PR guard, latest result & verdicts, fix prompt formatting/scrubbing/fence-breakout/clipboard, standalone installer, and stdio MCP server). Zero network calls in tests.

---

## 6. Open Questions for the Owner

1. **Repo strategy (shared vs dedicated public repo):** Should Cursor Marketplace be submitted from a dedicated public repo (`megalens/megalens-cursor-plugin`, with `CURSOR-README.md` as its root `README.md` and no Claude Code `commands/` folder) or from the same repo as the Claude Code plugin? A dedicated repo avoids any confusion if Cursor's submission review script (`validate-template.mjs`) scans the root `commands/` directory instead of honoring `"commands": "./cursor/commands/"` from `.cursor-plugin/plugin.json`.
2. **GitHub Actions runner auth without `MEGALENS_TOKEN` repo secret:** Browser OAuth signs the user into MegaLens inside Cursor (`https://megalens.ai/api/mcp?ide=cursor`) with zero token copy-paste, and `gh auth login --web` signs into GitHub in the browser. However, the existing `templates/megalens-dispatch.yml` workflow's `create` job still reads `${{ secrets.MEGALENS_TOKEN }}` from GitHub Actions repository/organization secrets (same as the Claude Code plugin). Once the MegaLens GitHub App (roadmap item 1) is live, do you want the Cursor plugin to default to the GitHub App path (eliminating the one-time `gh secret set MEGALENS_TOKEN` step completely) with the user's GitHub runner as the fallback?
3. **Live Cursor OAuth callback verification:** `https://megalens.ai/oauth/register` supports Dynamic Client Registration, which Cursor Desktop and Cursor Web use with redirect URIs `http://localhost:8787/callback` and `https://www.cursor.com/agents/mcp/oauth/callback`. Confirm in a live Cursor Desktop test that MegaLens's `/oauth/register` allows both redirect URIs and that `ide=cursor` is recorded cleanly in server logs/metrics.
4. **Live Cursor Desktop smoke test:** Like the Claude Code plugin before owner testing, nothing here was run inside a live Cursor GUI session on this headless Linux VPS. Run a quick manual smoke test in Cursor Desktop (install via `~/.cursor/plugins/local/megalens`, reload window, check `/megalens-review`, `/megalens-result`, `/megalens-fix-prompt`, and MCP OAuth connect) before submitting to `cursor.com/marketplace/publish`.

---

## Fix round (2026-11-22 — addressing `/root/review-input/rv-cursor/SOL.md` & `REPORT-CURSOR.md`)

All 8 findings from the review were audited against the codebase, official Cursor validator (`cursor/plugin-template/scripts/validate-template.mjs`), and GitHub CLI `2.88.1` behavior.

### Finding-by-finding resolution

1. **High — The GitHub runner sends code through MegaLens (Upstream / Owner Constraint — not changed to direct BYO-key):**
   - **Evidence:**
     - `templates/megalens-dispatch.yml:34,63,94` (and `cursor/templates/megalens-dispatch.yml:34,63,94`) pin `megalens/review-action@950eb5f1eeff21008fcf585587b88fc83546cdcf` (`v1.2.0`, engine `0.1.3`), which runs in gateway mode.
     - `scripts/lib/engine-core.mjs:4-9` and `PLUGIN-NEEDS.md:9` record the standing owner decision (20 Nov 2026, CONTRACT §7) keeping `BYO_KEY_ENABLED = false` and `BYO_LOGIN_ENABLED = false` by constant with no env or flag switch.
     - `README.md:171`, `cursor/README.md:5-9`, `cursor/rules/megalens.mdc:8`, `cursor/skills/megalens-code-review/SKILL.md:38`, and `cursor/scripts/lib/cursor-commands.mjs:39-40` repeat the exact GitHub Action privacy disclosure verbatim (*"The whole repo is not uploaded. Code excerpts the reviewer reads, and the diff, pass through the gateway to MegaLens and OpenAI in gateway mode. Findings stay as an artifact in your GitHub repository; nothing is kept on our side."*) and never claim zero code reaches MegaLens servers.
   - **Status:** Intentionally kept in gateway mode per CONTRACT §7 and pinned `review-action@950eb5f`; requires an owner decision and a new `megalens/review-action` release before any direct-to-provider mode can be enabled. Regression test in `tests/cursor-plugin.test.mjs` asserts the exact privacy wording and guards against contradictory claims.

2. **High — Browser sign-in cannot set up a fresh runner without a manual token paste (Partially fixed in plugin; backend/Action provisioning blocker documented):**
   - **Fixed in this repo:**
     - Upgraded `cursorSignInStatus` (`cursor/scripts/lib/cursor-commands.mjs:643-707`) so it no longer falsely reports Cursor's native hosted MCP OAuth connection as "not signed in locally": it distinguishes Cursor-managed hosted MCP OAuth (`Customize -> MCP -> megalens -> Connect`), optional CLI OS-keychain status, `gh` CLI active login, and actual GitHub Actions runner readiness for the current repo (workflow `.github/workflows/megalens-dispatch.yml` on the default branch + read-only `MEGALENS_TOKEN` repo/org secret presence check).
     - Updated `cursor/README.md:23-44`, `cursor/commands/megalens-login.md:1-16`, `cursor/rules/megalens.mdc:12`, and `cursor/skills/megalens-code-review/SKILL.md:32-34` to accurately state that browser OAuth handles hosted MCP sign-in and `gh auth login --web` handles GitHub CLI sign-in, while the pinned `megalens/review-action` v1.2.0 workflow still requires a one-time `gh secret set MEGALENS_TOKEN` per repo/org.
     - Added unit test coverage in `tests/cursor-plugin.test.mjs` (`cursorSignInStatus distinguishes Cursor native MCP OAuth and checks workflow + MEGALENS_TOKEN readiness without reading secrets`).
   - **External blocker (`file:line` evidence):**
     - `templates/megalens-dispatch.yml:33-40` pins `megalens/review-action@950eb5f` (`mode: create`), which requires `${{ secrets.MEGALENS_TOKEN }}`.
     - MegaLens's OAuth endpoints (`https://megalens.ai/.well-known/oauth-protected-resource`) issue RFC 8707 tokens scoped to `mcp` for `https://megalens.ai/api/mcp`; no documented endpoint exists in this plugin repo to mint/provision a GitHub Actions `MEGALENS_TOKEN` from Cursor's host-stored OAuth session, nor can the local stdio server read Cursor's native OAuth token. Full zero-paste runner provisioning requires the MegaLens GitHub App or a backend/Action provisioning flow outside this repository.

3. **High — Automatic PR detection silently falls back to the wrong review range (Fixed + Tested):**
   - **Fix:** In `resolvePrTarget` (`cursor/scripts/lib/cursor-commands.mjs:270-318`), removed `-R nwo` from the no-argument `gh pr view` path so GitHub CLI `2.88.1` uses checkout context instead of failing with `argument required when using the --repo flag` (explicit `--pr <number>` retains `<number>` + `-R nwo`). Added `NO_PR_RE` (`cursor/scripts/lib/cursor-commands.mjs:47`) so only genuine absence of a current-branch PR falls back to the default branch; any lookup/API/auth/CLI error now stops loudly with exit code `4` and dispatches nothing.
   - **Tests:** Updated `fakeExec` in `tests/cursor-plugin.test.mjs` to enforce the real `gh` `2.88.1` `--repo`-requires-selector rule, and added tests for auto-detected PR targeting a non-default `release` branch, auto-detected cross-repo fork PR refusal, `gh pr view` lookup error refusal, and genuine no-PR fallback.

4. **Medium — Terminal browser sign-in writes OAuth secrets to disk (Fixed + Tested):**
   - **Fix:** Replaced plaintext `~/.megalens/cursor-auth.json` file storage in `cursor/scripts/lib/browser-auth.mjs` with OS credential store adapters (`createOsSecretStore`: macOS Keychain via `security -i`, Linux Secret Service via `secret-tool`, Windows Credential Manager via PowerShell `PasswordVault`), delivering secrets exclusively over stdin (never argv, never plaintext files). If no OS credential store is available, `set()` fails closed and directs the user to Cursor's encrypted host OAuth (`Customize -> megalens -> Connect`).
   - **Tests:** Added OS adapter tests (macOS/Linux/Windows mocked `exec` verifying stdin-only secret transfer, zero secrets in `argv`, and fail-closed error when keychain is missing) and updated the PKCE/refresh test to use `createMemorySecretStore()` with zero files written to disk.

5. **Medium — The finding list can put credential-shaped text back into Cursor output (Fixed + Tested):**
   - **Fix:** Added `scrubModelText` (`cursor/scripts/lib/cursor-commands.mjs:59-66`) covering exact env vars, `scrub()` patterns, AWS keys, GitLab tokens, Slack tokens, Google API keys, and JWTs. Applied `formatLocation(f, env)` and `scrubModelText` across `cursorLatestResult` (both rendered model lines and numbered finding list, while keeping `Run: https://...` URLs intact via `scrubExact` so repo names like `ml-e2e-review-test` are not mangled), `cursorFixPrompt` chooser and prompts, and `saveCachedResult`.
   - **Tests:** Added synthetic credential-in-path redaction tests (`sk-proj-*`, `ml_tok_*`, `AKIA*`, `xoxb-*`, `Bearer *`, exact `MEGALENS_TOKEN`) across `cursorLatestResult`, `cursorFixPrompt` chooser (`--from-file`), and single fix prompts, plus a regression check preserving `ml-e2e-review-test` in the `Run:` URL.

6. **Medium — The advertised one-click install gives users only the hosted MCP server (Fixed + Tested):**
   - **Fix:** Relabeled the remote deeplink in `cursor/README.md`, `cursor/scripts/cursor-cli.mjs`, and `cursor/scripts/lib/cursor-deeplink.mjs` as **Hosted MCP server sign-in link (hosted MCP server only — does not install commands, rule, skill, or local runner)**. Added `install --local-plugin` (`installCursorLocalPlugin` in `cursor/scripts/cursor-cli.mjs:184-202`) to copy the complete, self-contained `cursor/` plugin package directly into `~/.cursor/plugins/local/megalens` without symlinks. Removed the unpublished 404 `https://github.com/megalens/megalens-cursor-plugin` URL from `cursor/.cursor-plugin/plugin.json` and `cursor/README.md`.
   - **Tests:** Added tests for `installCursorLocalPlugin` verifying all plugin files are copied with zero symlinks, idempotency, and a real standalone stdio MCP handshake spawned from the copied `~/.cursor/plugins/local/megalens/scripts/cursor-mcp-server.mjs` outside the repo, plus README assertions against the dead URL and for hosted-MCP-only labeling.

7. **Medium — The submission package fails Cursor's official template validator (Fixed + Tested):**
   - **Fix:** Moved the Cursor plugin into a self-contained package root at `cursor/` (with `cursor/.cursor-plugin/plugin.json`, dedicated `cursor/README.md`, `cursor/LICENSE`, `cursor/package.json`, `cursor/assets/logo.svg`, `cursor/mcp.json`, `cursor/commands/`, `cursor/rules/`, `cursor/skills/`, `cursor/scripts/`, and `cursor/templates/megalens-dispatch.yml`) and pointed root `.cursor-plugin/marketplace.json` to `"source": "cursor"`. Removed the conflicting root `.cursor-plugin/plugin.json`, root `mcp.json`, root `CURSOR-README.md`, and root `scripts/cursor-*` duplicates so Cursor's official validator scans `cursor/commands/` rather than Claude Code's root `commands/`. Updated `README.md` to link to `cursor/README.md`.
   - **Verification & Tests:** Ran Cursor's official `https://raw.githubusercontent.com/cursor/plugin-template/main/scripts/validate-template.mjs` against the repository root — exited `0` (`Validation passed.`). Added tests in `tests/cursor-plugin.test.mjs` verifying marketplace/package structure, frontmatter, self-containment, and byte-identity of shared files (`LICENSE`, `templates/megalens-dispatch.yml`, `scripts/lib/engine-core.mjs`, `scripts/lib/gh-runner.mjs`).

8. **Medium — A fix prompt can come from an older run or a different branch (Fixed + Tested):**
   - **Fix:** In `cursorFixPrompt` (`cursor/scripts/lib/cursor-commands.mjs:555-580`), always resolve `targetId` first (`id` if supplied, otherwise `await findLatestRun(...)`) before reading the repository cache, and reuse cached findings only when `cached.runId === targetId`. Also stored the effective status (`effectiveStatus(..., exitCode)`) in `saveCachedResult` and `headSha` in `saveLastRun`.
   - **Tests:** Added tests in `tests/cursor-plugin.test.mjs` verifying branch/run switches fetch the new run (`gh:20`) instead of serving stale cached `gh:10`, repeated calls for the same run (`gh:20`) hit the cache without re-downloading, and switching to a branch with an `in_progress` run (`gh:30`) reports still running instead of serving stale cached findings.

### Verification

- Official Cursor validator (`validate-template.mjs`): **passed** (exit `0`, 0 errors).
- `npm test`: **155 / 155 passing** (all offline, zero external network calls).

## Fix round (2026-11-22, SOL-CONFIRM1)

Reviewed the initial findings, verdict, and previous fix notes before applying the changes from [SOL-CONFIRM1.md](/root/review-input/rv-cursor/SOL-CONFIRM1.md).

| Finding | Resolution and evidence |
|---|---|
| #1 High. Gateway receives review code | **Open, requires an upstream release and owner decision.** The pinned Action receives the review key and runs in gateway mode at `cursor/templates/megalens-dispatch.yml:63`. The release documents that code and diffs pass through the gateway and that the direct provider key path is disabled. The owner decision also disables both BYO modes at `cursor/scripts/lib/engine-core.mjs:4` and `PLUGIN-NEEDS.md:9`. The contract test at `tests/cursor-plugin.test.mjs:896` checks the pin, disabled modes, and disclosure. [Pinned Action data flow](https://raw.githubusercontent.com/megalens/review-action/950eb5f1eeff21008fcf585587b88fc83546cdcf/README.md) |
| #2 High. Browser sign-in leaves a manual runner credential step | **Open, requires a backend provisioning flow or a compatible Action release.** The hosted OAuth endpoint and local process are separate at `cursor/mcp.json:3`. The Action's create job consumes a MegaLens account token from GitHub Actions secrets at `cursor/templates/megalens-dispatch.yml:33`. Local preflight checks the secret name at `cursor/scripts/lib/gh-runner.mjs:133`. There is no runner credential exchange in the clone. The test at `tests/cursor-plugin.test.mjs:931` confirms that a signed-in MCP session still stops before dispatch when the runner credential is missing. [Pinned Action inputs](https://raw.githubusercontent.com/megalens/review-action/950eb5f1eeff21008fcf585587b88fc83546cdcf/action.yml) |
| #3 High. Automatic PR detection can select the wrong range | **Fixed.** Selectorless lookup uses checkout context at `cursor/scripts/lib/cursor-commands.mjs:288`. Only GitHub CLI's branch-specific no-PR result or a closed or merged PR permits default-branch fallback. Detached checkout errors and incomplete PR metadata stop before dispatch. Every open PR uses GitHub's PR base commit at `cursor/scripts/lib/cursor-commands.mjs:426`, including PRs whose target is the default branch. Implicit reviews use local `HEAD`. Explicit `--pr` uses the PR head commit. Coverage includes a stale default ref, transient repository lookup failure, detached checkout, incomplete metadata, and earlier fork and no-PR cases. `tests/cursor-plugin.test.mjs:473`, `tests/cursor-plugin.test.mjs:568`. [GitHub CLI PR finder](https://github.com/cli/cli/blob/v2.88.1/pkg/cmd/pr/shared/finder.go#L380-L414) |
| #6 Medium. Hosted link only installs one server and full installation needs a source | **Fixed for archive distribution.** The hosted link is labeled at `cursor/README.md:87`. The package allowlist at `cursor/package.json:7` and install instructions at `cursor/README.md:53` produce a complete plugin archive for installation without a checkout. The test at `tests/cursor-plugin.test.mjs:950` checks the archive contents, installs from an empty directory, and starts the installed stdio server. The handoff archive is available locally. Public hosting and Cursor Desktop verification remain pending. [Cursor local plugin layout](https://cursor.com/docs/plugins#test-plugins-locally) |
| #8 Medium. A fix prompt can use a review from another commit or an old attempt | **Fixed.** Implicit fix prompts require a recent workflow run whose title names the current commit at `cursor/scripts/lib/cursor-commands.mjs:339`. A run listing error stops selection. Cache reuse requires a matching run ID and completed attempt confirmed by GitHub at `cursor/scripts/lib/cursor-commands.mjs:578`. Numbered results include the exact run ID at `cursor/scripts/lib/cursor-commands.mjs:517`. The test at `tests/cursor-plugin.test.mjs:775` covers branch switches without a match, GitHub lookup failure, explicit run selection, and reruns. |
| New High. Auto-detected release PRs bypass the dirty checkout guard | **Fixed.** Cursor sets the clean checkout requirement from the user's arguments at `cursor/scripts/lib/cursor-commands.mjs:442`. Runner preflight stops on dirty status or a status error before dispatch at `cursor/scripts/lib/gh-runner.mjs:175`. The test at `tests/cursor-plugin.test.mjs:603` confirms zero dispatches in both cases and verifies the warning for explicitly selected PRs. |

**Verification.** `npm test` passed all 161 tests. Cursor's official validator passed for the clone and for the exact archive staged with the repository marketplace manifest. Both runs reported only the optional hooks notice. `git diff --check` passed. No live paid review was run. [Official validator](https://github.com/cursor/plugin-template/blob/main/scripts/validate-template.mjs)

**Archive.** `/tmp/megalens-cursor-fix.ZgJPt8/megalens-cursor-plugin-0.1.0.tgz`. SHA-256 `03b94eb73ce81add5565bcfe9f9418d2db4eb40aec020cbfa2bec5155168f1f4`.

## Fix round

The review history through 22 November 2026 leaves findings #1 and #2 open. [NEON-CONFIRM2](/root/review-input/rv-cursor/NEON-CONFIRM2.md)

1. **#1. The runner sends review code through MegaLens. Open.** Cursor's review command and MCP tool now tell the agent to explain the data flow before dispatch and to stop if the user requires the code to stay off MegaLens servers. The CLI prints the same notice before dispatch. The published Action still sends diffs and code excerpts through the gateway. Its direct OpenAI mode is disabled. CONTRACT §7 designates gateway mode for launch. Closing this finding requires either an owner decision accepting the disclosed data flow or an approved Action and engine release that sends review traffic directly to the provider. [Pinned Action data flow](https://github.com/megalens/review-action/blob/950eb5f1eeff21008fcf585587b88fc83546cdcf/README.md#what-leaves-the-runner) · [Owner decision](/root/CURRENT-EXECUTION/MegaLens/engine-v2/CONTRACT.md:120)

2. **#2. A fresh runner still needs an Action token. Open.** The sign in status and missing secret error show where to create the Action token and how to add it in the terminal. The status command points to the bundled workflow template. Browser OAuth authorizes the hosted MCP resource. The pinned Action's create job requires an account token from GitHub Actions secrets. Setup without manual token entry requires a supported way to provision that secret or authorize the runner. [OAuth resource metadata](https://megalens.ai/.well-known/oauth-protected-resource/api/mcp) · [Action token setup](https://megalens.ai/docs/github-action) · [Dispatch workflow](cursor/templates/megalens-dispatch.yml#L26)

The tests verify that the CLI prints the gateway notice before `gh workflow run` and that the Cursor command and tool metadata both carry the disclosure. A separate test verifies that a signed in OAuth user with a missing Action token gets setup instructions without a credential write or dispatch. Both use mocked GitHub calls.

`npm test` passed all 162 tests. `git diff --check` passed. Cursor's package validator passed with its optional hooks notice. Live Cursor Desktop and a paid GitHub Actions run were outside this verification. [Cursor validator](https://github.com/cursor/plugin-template/blob/main/scripts/validate-template.mjs)

## Fix round (2026-11-23, NEON-CONFIRM3)

The latest review carries forward two high findings. The earlier PR selection, dirty checkout, keychain, redaction, packaging, and run cache regressions remain covered by the full suite. [Review](/root/review-input/rv-cursor/NEON-CONFIRM3.md)

1. **#1 High. Review code passes through MegaLens. Mitigated in Cursor. Direct transport remains open.** Cursor CLI and MCP now stop before review preflight and dispatch unless the request explicitly allows the gateway transfer. The Cursor command asks for approval after explaining what is sent, and the CLI requires `--allow-gateway`. The MCP flag is the client's assertion of that approval. The workflow still invokes the gateway Action with a review key at `cursor/templates/megalens-dispatch.yml:63`. The published Action disables direct OpenAI mode, and the local plugin records the owner decision to disable BYO keys at `cursor/scripts/lib/engine-core.mjs:7`. A compatible Action release and an approved direct provider mode are required to run a review without sending code through MegaLens. Tests at `tests/cursor-plugin.test.mjs:908` and `tests/cursor-plugin.test.mjs:934` cover approved dispatch and refusals on both entry points. [Pinned Action data flow](https://raw.githubusercontent.com/megalens/review-action/950eb5f1eeff21008fcf585587b88fc83546cdcf/README.md)

2. **#2 High. Fresh runner without an existing Action secret requires manual setup. Open.** The hosted MCP and local runner use separate connections at `cursor/mcp.json:3` and `cursor/mcp.json:6`. Browser authorization targets the MCP resource at `cursor/scripts/lib/browser-auth.mjs:262`. Runner preflight checks GitHub secret names at `cursor/scripts/lib/gh-runner.mjs:134`, and the pinned Action reads an Action token from GitHub Actions secrets at `cursor/templates/megalens-dispatch.yml:40`. The published OAuth metadata advertises the `mcp` scope, and the Action setup documents a separate Action token. Browser provisioning needs a supported service exchange or a compatible Action authentication flow. The test at `tests/cursor-plugin.test.mjs:981` verifies that hosted OAuth and a local environment token cannot stand in for a missing GitHub secret. It covers setup instructions on CLI and MCP, no credential passed to child processes, and no secret write or dispatch. The test at `tests/cursor-plugin.test.mjs:1007` verifies dispatch for a fresh repository that already has access to a shared organization Action secret. [OAuth resource metadata](https://megalens.ai/.well-known/oauth-protected-resource/api/mcp) · [Action setup](https://megalens.ai/docs/github-action)

`npm test` passed all 164 tests. `git diff --check` passed. The CLI and stdio MCP subprocesses also refused a review request without approval. GitHub dispatch and browser credentials were tested with mocks. Live Cursor Desktop, paid GitHub Actions reviews, and provider traffic were outside this verification.

## Fix round (2026-11-23, LOOP-CONFIRM9)

Read the review history in order through [LOOP-CONFIRM9.md](/root/review-input/rv-cursor/LOOP-CONFIRM9.md). It carries forward two high findings.

1. **#1 Gateway transfer. GitHub-side approval enforced for the updated workflow. Direct provider transport remains open.** A direct GitHub dispatch could previously bypass the Cursor CLI and MCP check at `cursor/scripts/lib/cursor-commands.mjs:419`. The bundled workflow now defaults `allow_gateway` to false at `cursor/templates/megalens-dispatch.yml:20` and stops before review creation when approval is absent at line 42. The shared runner sends approval for the updated template at `cursor/scripts/lib/gh-runner.mjs:219`. Current clients also work with older installed templates. Runner-side enforcement takes effect when the updated workflow reaches the default branch. Successful dispatch then requires the approval input. Approved runs still send code through MegaLens because the workflow invokes the gateway Action at `cursor/templates/megalens-dispatch.yml:80` and the owner decision disables BYO keys at `cursor/scripts/lib/engine-core.mjs:7`. A supported direct mode requires a compatible upstream release and an updated owner decision. Tests at `tests/cursor-plugin.test.mjs:926` and `tests/cursor-plugin.test.mjs:945` cover refusal and approved dispatch. [Pinned Action data flow](https://github.com/megalens/review-action/blob/950eb5f1eeff21008fcf585587b88fc83546cdcf/README.md#what-leaves-the-runner)

2. **#2 Browser-only runner provisioning remains open.** The updated workflow stops before invoking the Action when GitHub has no credential, even if the local CLI lacks permission to list secret names. The check receives a boolean at `cursor/templates/megalens-dispatch.yml:40` and fails with setup instructions at line 46. The Action takes its account credential from GitHub Actions secrets at line 57. Cursor uses separate hosted MCP and runner connections at `cursor/mcp.json:3` and `cursor/mcp.json:6`, and CLI browser sign-in requests the advertised MCP resource and scope at `cursor/scripts/lib/browser-auth.mjs:372`. The service advertises authorization-code and refresh grants for the `mcp` scope and documents separate Action token issuance. A supported credential exchange or runner authentication flow is required for a fresh repository with no shared organization credential. Tests at `tests/cursor-plugin.test.mjs:936`, `tests/cursor-plugin.test.mjs:1024`, and `tests/cursor-plugin.test.mjs:1050` cover the workflow failure, signed-in MCP with no runner credential, and successful dispatch with a shared organization credential. [OAuth resource metadata](https://megalens.ai/.well-known/oauth-protected-resource/api/mcp) · [OAuth issuer metadata](https://megalens.ai/.well-known/oauth-authorization-server) · [Action token setup](https://megalens.ai/docs/github-action)

The new workflow tests and the strengthened dispatch test failed before the code changes and passed afterward. `npm test` passed all 166 tests. `actionlint` passed for both bundled workflows and `git diff --check` passed. Verification used mocked GitHub dispatch and executed the workflow prerequisite script locally.

## Fix round (2026-11-23, LOOP-CONFIRM1)

Read the review history in timestamp order. The latest review carries forward two high findings. [LOOP-CONFIRM1.md](../rv-cursor/LOOP-CONFIRM1.md)

1. **#1 High. Fixed automatic approval for the guarded workflow. Direct provider transport remains open.** The same workflow serves both plugin entry points. The root client previously set `allow_gateway=true` whenever the installed template exposed the input, including requests without transfer approval. The runner now requires explicit approval before dispatching that workflow. Cursor forwards its existing approval and the root CLI accepts `--allow-gateway` for the same workflow. The regression test exercises refusal and a single approved dispatch through the root CLI. Approved reviews still send diffs and excerpts through MegaLens. The workflow calls the pinned Action, which disables direct OpenAI mode, and the engine records the owner decision to keep BYO keys disabled. Closing the transport finding requires a compatible Action release and an approved direct mode. [Runner guard](scripts/lib/gh-runner.mjs#L217) · [Cursor approval](cursor/scripts/lib/cursor-commands.mjs#L422) · [Regression test](tests/gh-runner.test.mjs#L287) · [Workflow](cursor/templates/megalens-dispatch.yml#L80) · [BYO decision](cursor/scripts/lib/engine-core.mjs#L7) · [Pinned Action data flow](https://github.com/megalens/review-action/blob/950eb5f1eeff21008fcf585587b88fc83546cdcf/README.md#what-leaves-the-runner)

2. **#2 High. Fixed a false missing-secret result. Browser-only runner provisioning remains open.** GitHub can hide an organization secret list behind a 404. Cursor status and dispatch preflight now share one secret-name check. An unreadable organization list yields unknown, so the workflow can check the credential before invoking the Action. A confirmed missing repository or organization credential still stops preflight. The regression test covers the 404 on Cursor status and dispatch without writing a secret. Fresh repositories without a shared Action secret still require provisioning. Cursor's hosted OAuth session belongs to the MCP connection, and the workflow's create step consumes an Action token from GitHub Actions secrets. The published setup requires separate token issuance. Browser-only setup needs a supported credential exchange or an Action authentication flow that accepts browser authorization. [Secret check](cursor/scripts/lib/gh-runner.mjs#L117) · [Workflow prerequisite](cursor/templates/megalens-dispatch.yml#L37) · [Regression test](tests/cursor-plugin.test.mjs#L1079) · [Connections](cursor/mcp.json#L3) · [Create input](cursor/templates/megalens-dispatch.yml#L57) · [GitHub 404 behavior](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource) · [Action setup](https://megalens.ai/docs/github-action)

Both regression tests failed before the code changes and passed afterward. `npm test` passed all 168 tests, and `git diff --check` passed. Verification used mocked GitHub dispatch and local execution of the bundled workflow prerequisite. Live Cursor, paid GitHub Actions reviews, and provider traffic were outside this verification.

## Fix round (product facts)

The coordinator resolved findings #1 and #2 as product facts. This entry supersedes their earlier open status.

1. **Gateway data flow.** The READMEs, command instructions, and runner notices now use the Action's privacy wording. The GitHub runner sends the diff and code excerpts through the MegaLens gateway to OpenAI. MegaLens does not keep the code. The review still asks for approval before dispatch. [Pinned Action data flow](https://github.com/megalens/review-action/blob/950eb5f1eeff21008fcf585587b88fc83546cdcf/README.md#what-leaves-the-runner)
2. **Browser setup for the repository secret.** The setup docs and missing secret messages lead with `npx megalens-review init`. The initializer sends the Action token to `gh` on stdin to set `MEGALENS_TOKEN` without a paste. Users can decline the separate pull request for automatic PR reviews. The review command dispatches `.github/workflows/megalens-dispatch.yml` on the default branch. Manual token entry remains a fallback. The published `megalens-review` package at `0.1.3` lacks `init`. The browser setup requires a release that includes the initializer. [Published package](https://www.npmjs.com/package/megalens-review/v/0.1.3)

`npm test` passed all 169 tests. They cover the disclosure, setup guidance, and dispatch with mocked GitHub calls. A live browser sign in and paid review were outside this run.
