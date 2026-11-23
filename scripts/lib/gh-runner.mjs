// Review through MegaLens's GitHub App (our review machine) or the user's own GitHub Actions runner.
// Every `gh` / `git` call goes through an injectable `exec(cmd, args, {cwd, env, signal})` -> {code, stdout, stderr},
// and every MegaLens App API call goes through an injectable `fetch(url, init)` so tests run with fixtures and no network.
// MEGALENS_TOKEN is sent only in the Authorization: Bearer header to a validated MegaLens API origin; it is never
// passed to `gh`/`git` subprocesses, never put in CLI args or URLs, never stored in bookmarks, and never printed.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveStatus, renderResult, scrub } from './engine-core.mjs';
import { DEFAULT_POLL_MS, DEFAULT_PROGRESS_MS, DEFAULT_WAIT_MS, STILL_RUNNING_LINE, defaultSleep, raceWithDeadline, waitForReview } from './wait-loop.mjs';

export const WORKFLOW_FILE = 'megalens-dispatch.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
export const WORKFLOW_NAME = 'MegaLens Dispatch';
export const ARTIFACT_NAME = 'megalens-findings';
export const SECRET_NAME = 'MEGALENS_TOKEN';
export const CHECK_NAME = 'MegaLens review';
export const APP_INSTALL_URL = 'https://megalens.ai/app/start';
export const APP_BILLING_URL = 'https://megalens.ai/app/settings/billing';
export const DEFAULT_APP_ORIGIN = 'https://megalens.ai';
export const APP_PATH_ENABLED = true;
export const RUN_ID_RE = /^gh:([1-9][0-9]{0,17})$/;
export const APP_JOB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APP_ID_RE = /^app:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_FINDINGS = 1 << 22;
const APP_REQUEST_TIMEOUT_MS = 30_000;
const APP_LOST_REPLY_RETRY_MS = 1000;

export const templatePath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', WORKFLOW_FILE);
export const workflowText = () => readFileSync(templatePath(), 'utf8');

export class SetupError extends Error { constructor(msg, { needsUser = false } = {}) { super(msg); this.needsUser = needsUser; } }
class GhUnavailableError extends SetupError {}

/** Remove exact secret values and token shapes from text while preserving repo names like megalens/ml-e2e-review-test. */
export function scrubExact(text, env = {}) {
  let t = String(text ?? '');
  for (const k of ['MEGALENS_TOKEN', 'OPENAI_API_KEY', 'MEGALENS_REVIEW_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
    const v = env[k];
    if (typeof v === 'string' && v.length >= 6) t = t.split(v).join('[redacted]');
  }
  return t
    .replace(/\bml_tok_[0-9a-f]{16,}/gi, '[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_=-]+){2}/g, '[redacted]')
    .replace(/\bghs_[A-Za-z0-9_.-]{14,}[A-Za-z0-9_=-]/g, '[redacted]')
    .replace(/\[redacted\]\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_=-]{8,}/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]');
}

export const isRunnerId = (s) => typeof s === 'string' && RUN_ID_RE.test(s);
export const runIdOf = (s) => { const m = RUN_ID_RE.exec(String(s ?? '')); if (!m) throw new SetupError('that is not a GitHub review id (they look like gh:123456789)'); return m[1]; };
export const isAppId = (s) => typeof s === 'string' && APP_ID_RE.test(s);
export const appJobIdOf = (s) => {
  const m = APP_ID_RE.exec(String(s ?? ''));
  if (!m) throw new SetupError('that is not a MegaLens App review id (they look like app:00000000-0000-4000-8000-000000000001)');
  return m[1].toLowerCase();
};

/** True for a local engine setup error: binary missing or the sandbox pre-check failed (exit 4). */
export function shouldFallBack({ code, stderr = '', docNotes = '' }) {
  if (code === 127) return true;
  return code === 4 && /blocks nested sandboxes|sandbox_unusable|nested sandbox/i.test(`${stderr}\n${docNotes}`);
}

/**
 * The engine's own sandbox pre-check document (engine-v2 failureDoc with reason sandbox_unusable), judged by structured fields only:
 * exit 4, no real review id (rv_none), no findings, and a pass whose reason is exactly sandbox_unusable. Never searches text.
 */
export function isSandboxPrecheckDoc(doc, code) {
  return code === 4 && !!doc && typeof doc === 'object' && doc.review_id === 'rv_none'
    && Array.isArray(doc.findings) && doc.findings.length === 0
    && Array.isArray(doc.passes) && doc.passes.some((p) => p && p.reason === 'sandbox_unusable');
}

/** Environment for gh and git: an allowlist. No MegaLens or OpenAI secrets are passed. GH_TOKEN / GITHUB_TOKEN are for gh itself. */
export function ghEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(PATH|HOME|USER|USERNAME|LOGNAME|LANG|TERM|TMPDIR|TEMP|TMP|SHELL|TZ|CI|GH_TOKEN|GITHUB_TOKEN|GH_HOST|GH_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GH_PROMPT_DISABLED|NO_COLOR|SystemRoot|SYSTEMROOT|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ComSpec|PATHEXT|HTTPS?_PROXY|NO_PROXY|SSH_AUTH_SOCK|GIT_SSH_COMMAND)$/i.test(k) || /^(LC_|XDG_)/.test(k)) out[k] = v;
  }
  out.GH_PROMPT_DISABLED = '1'; out.GIT_TERMINAL_PROMPT = '0'; out.NO_COLOR = '1';
  return out;
}

const KILL_GRACE_MS = 150;
const DEFINITIVE_DISPATCH_REFUSAL_RE = /\bHTTP 4(?:00|01|03|04|22)\b|could not find any workflows|does not have (?:a )?workflow_dispatch|workflow.*disabled|not enabled|invalid inputs|required input/i;

function killChildTree(child, sig) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try { process.kill(-child.pid, sig); } catch { /* process group may already be gone */ }
  }
  try { child.kill(sig); } catch { /* ignore */ }
}

/** Real exec: spawn without a shell, capped output, kills child (and its process group) promptly on AbortSignal with guaranteed SIGKILL fallback. Missing binary -> code 127. */
export function realExec(cmd, args, { cwd, env, signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: 4, stdout: '', stderr: '', aborted: true });
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: ghEnv(env ?? {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) { return resolve({ code: 127, stdout: '', stderr: String(e.message) }); }
    let stdout = ''; let stderr = ''; let settled = false; let exited = false; let killTimer = null;
    const clearKillTimer = () => {
      if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
    };
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(res);
    };
    const onAbort = () => {
      if (!exited) {
        killChildTree(child, 'SIGTERM');
        // Keep killTimer ref'd until the child actually exits so SIGKILL always fires even if the parent is exiting.
        killTimer = setTimeout(() => {
          killTimer = null;
          if (!exited) killChildTree(child, 'SIGKILL');
          child.unref?.();
        }, KILL_GRACE_MS);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code: 4, stdout, stderr, aborted: true });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => { if (stdout.length < MAX_FINDINGS) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_FINDINGS) stderr += c; });
    child.on('error', (e) => {
      exited = true;
      clearKillTimer();
      finish({ code: e.code === 'ENOENT' ? 127 : 4, stdout, stderr: String(e.message) });
    });
    child.on('exit', () => {
      exited = true;
      clearKillTimer();
    });
    child.on('close', (code) => {
      exited = true;
      clearKillTimer();
      finish({ code: code ?? 4, stdout, stderr });
    });
  });
}

const firstLine = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, n);
const short = (sha) => String(sha).slice(0, 7);
const jsonOf = (s) => { try { return JSON.parse(s); } catch { return null; } };
const SHA_RE = /^[0-9a-f]{40}$/i;
const NWO_RE = /^[\w.-]+\/[\w.-]+$/;

function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return 0;
}

const MAX_CLAUDE_CONFIG_BYTES = 5 * 1024 * 1024;
const CLAUDE_BEARER_TOKEN_RE = /^Bearer\s+(ml_tok_[0-9a-f]{16,128})$/i;

/**
 * Resolve Claude Code's user-scoped MCP config path (matching `@megalens/mcp` browser sign-in):
 * `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set, otherwise `$HOME/.claude.json`.
 * Never reads project/workspace `.mcp.json` or `.claude/settings.json`.
 */
export function resolveClaudeMcpConfigPath(env = {}) {
  const custom = typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (custom && !custom.startsWith('${')) return path.join(path.resolve(custom), '.claude.json');
  const home = (typeof env?.HOME === 'string' && env.HOME.trim())
    || (typeof env?.USERPROFILE === 'string' && env.USERPROFILE.trim())
    || (env === process.env ? homedir() : '');
  return home ? path.join(path.resolve(home), '.claude.json') : null;
}

/**
 * Read a MegaLens bearer token stored by browser sign-in (`@megalens/mcp setup`) in Claude Code's
 * user-scoped `.claude.json`. Accepts only entries pointing at `https://megalens.ai`.
 */
export function readClaudeMcpToken(env = {}) {
  const file = resolveClaudeMcpConfigPath(env);
  if (!file) return '';
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_CLAUDE_CONFIG_BYTES) return '';
    const data = jsonOf(readFileSync(file, 'utf8'));
    const entry = data?.mcpServers?.megalens;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
    if (typeof entry.url !== 'string' || !entry.url.trim()) return '';
    let u;
    try { u = new URL(entry.url.trim()); } catch { return ''; }
    if (u.origin !== DEFAULT_APP_ORIGIN) return '';
    const headers = entry.headers;
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
    const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
    if (!authKey || typeof headers[authKey] !== 'string') return '';
    const m = CLAUDE_BEARER_TOKEN_RE.exec(headers[authKey].trim());
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * Read the MegaLens bearer token from `MEGALENS_TOKEN` in env, or fall back to the trusted
 * user-scoped Claude Code MCP config written by browser sign-in. Never accepts placeholders.
 */
export function extractAppToken(env = {}) {
  const v = typeof env?.MEGALENS_TOKEN === 'string' ? env.MEGALENS_TOKEN.trim() : '';
  if (v && !v.startsWith('${')) return v;
  return readClaudeMcpToken(env);
}

/**
 * Resolve the MegaLens API origin for the GitHub App endpoints.
 * Pinned unconditionally to `https://megalens.ai` so project settings (e.g. `.claude/settings.json`
 * setting `MEGALENS_API_URL` or `MEGALENS_URL`) can never redirect the bearer token to another host.
 * Tests use injected `fetch` transport instead of overriding the production origin.
 */
export function resolveAppApiBase() {
  return { origin: DEFAULT_APP_ORIGIN };
}

/** Parse a GitHub owner/repo from a git remote URL (HTTPS or SSH). Returns null for non-GitHub URLs. */
export function parseGitHubRemote(rawUrl) {
  const s = String(rawUrl ?? '').trim();
  if (!s) return null;
  let m = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(s);
  if (!m) m = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i.exec(s);
  if (!m) {
    try {
      const u = new URL(s);
      if (u.hostname.toLowerCase() === 'github.com') {
        const cleanPath = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
        if (/^[^/]+\/[^/]+$/.test(cleanPath)) m = [s, cleanPath];
      }
    } catch { /* ignore */ }
  }
  const nwo = m?.[1] ?? '';
  if (!NWO_RE.test(nwo) || nwo.includes('..')) return null;
  return nwo;
}

function validGithubUrl(url, kind) {
  if (typeof url !== 'string') return false;
  return new RegExp(`^https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/${kind}\\/[1-9][0-9]*$`).test(url);
}

function parseRetryAfterSec(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.ceil(n);
}

function formatDurationSec(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'a moment';
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  const mins = Math.ceil(sec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins ? `${hrs}h ${remMins}m` : `${hrs} hour${hrs === 1 ? '' : 's'}`;
}

function linkedAbortSignal(parentSignal, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;
  let timer = null;
  const onParentAbort = () => ac.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ac.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  if (!ac.signal.aborted && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    timer.unref?.();
  }
  const cleanup = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  };
  return { signal: ac.signal, isTimedOut: () => timedOut, cleanup };
}

async function readBoundedResponseText(res, limit = MAX_FINDINGS) {
  const declared = Number(res.headers?.get?.('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  return Buffer.byteLength(text, 'utf8') > limit ? null : text;
}

/**
 * Make one authenticated JSON request to the MegaLens GitHub App API.
 * Never follows redirects, caps response bytes, honours AbortSignal and timeout, and scrubs token values from errors.
 */
async function appApiRequest({
  origin,
  token,
  method = 'GET',
  pathname,
  body = undefined,
  env = {},
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = APP_REQUEST_TIMEOUT_MS,
}) {
  if (signal?.aborted) return { ok: false, aborted: true, retryable: false };
  const scrubEnv = token ? { ...env, MEGALENS_TOKEN: token } : env;
  const url = `${origin}${pathname}`;
  const linked = linkedAbortSignal(signal, timeoutMs);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'megalens-claude-plugin/0.2',
    };
    const init = { method, headers, redirect: 'manual', signal: linked.signal };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      if (signal?.aborted) return { ok: false, aborted: true, retryable: false };
      const msg = linked.isTimedOut()
        ? 'request to MegaLens timed out'
        : scrubExact(oneLine(e?.message || 'network error', 200), scrubEnv);
      return { ok: false, status: 0, errorCode: null, retryable: true, networkError: msg };
    }
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        status: res.status,
        errorCode: 'redirect_refused',
        retryable: false,
        networkError: `MegaLens API returned an unexpected redirect (HTTP ${res.status}). The sign-in token is not forwarded across redirects.`,
      };
    }
    const retryAfterSec = parseRetryAfterSec(res.headers);
    let raw;
    try {
      raw = await readBoundedResponseText(res, MAX_FINDINGS);
    } catch (e) {
      if (signal?.aborted) return { ok: false, aborted: true, retryable: false };
      return { ok: false, status: res.status, errorCode: null, retryable: true, retryAfterSec, networkError: scrubExact(oneLine(e?.message || 'failed reading response', 200), scrubEnv) };
    }
    if (raw === null) {
      return { ok: false, status: res.status, errorCode: 'response_too_large', retryable: false, networkError: 'MegaLens response exceeded the size limit.' };
    }
    const data = jsonOf(raw);
    const errorCode = typeof data?.error === 'string' ? oneLine(data.error, 60) : null;
    if (res.status >= 200 && res.status < 300) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, status: res.status, errorCode: null, retryable: true, retryAfterSec, networkError: 'MegaLens returned an unreadable JSON response.' };
      }
      return { ok: true, status: res.status, data, retryAfterSec };
    }
    const retryable = res.status >= 500 || (res.status === 429 && errorCode !== 'daily_cap');
    return { ok: false, status: res.status, data, errorCode, retryable, retryAfterSec };
  } finally {
    linked.cleanup();
  }
}

export const MSG = {
  noGh: 'GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com, then run `gh auth login`, then run this again.',
  noLogin: 'GitHub CLI (`gh`) is not logged in. Run `gh auth login`, then run this again.',
  noRemote: 'This folder has no GitHub remote, so the review cannot run on GitHub. Create or connect the repository: `gh repo create` (new) or `git remote add origin https://github.com/OWNER/REPO.git` (existing), push, then run this again.',
  noSecret: `The repository secret ${SECRET_NAME} is missing. Set it once with \`gh secret set ${SECRET_NAME}\` (gh asks for the value; paste your MegaLens token there, not into the chat), then run this again.`,
  secretUnknown: `Could not check the repository secret ${SECRET_NAME} (no permission to list secrets). Going on; if it is missing the run fails at its first job and no review is charged.`,
  uncommitted: 'Note: uncommitted changes are not reviewable on GitHub. Only commits that are on GitHub are reviewed. Commit and push them first if you want them reviewed.',
  dirtyStop: 'You have uncommitted changes, and GitHub can only review commits that are on GitHub, so it would review a different change than the one you are editing. Nothing was started and no credit was used. Commit and push your changes, then run this again. (On Linux with the local engine, `--runner local` reviews uncommitted changes. To review only the commits already on GitHub, name the range: `--base <ref> --head HEAD`.)',
  worktreeUnknown: 'Could not check for uncommitted changes. Nothing was started. Run `git status` in this repository and resolve any Git errors before retrying.',
  secretCheckFailed: (why) => `Could not check the repository secret ${SECRET_NAME}: ${why || 'gh gave no reason'}. Nothing was started. Check your network and \`gh auth status\`, then run this again.`,
  orgSecretUnknown: `${SECRET_NAME} is not a repository secret, and the organisation secrets could not be read. Going on; if it is missing the run fails at its first job and no review is charged.`,
  notFound: (url) => `The workflow was started, but its run could not be found, so there is no id to give you. A review may have been started and charged: do NOT start another one. Open ${url} to find the run, then use its number as gh:<number> with /megalens:status and /megalens:result. Nothing has been reviewed yet.`,
  notSetup: APP_PATH_ENABLED
    ? `Install the MegaLens GitHub App or add the workflow: ${APP_INSTALL_URL}`
    : `Copy the plugin's templates/${WORKFLOW_FILE} to ${WORKFLOW_PATH} on your repository's default branch and push the change, then run this again.`,
  appDisabled: 'The MegaLens GitHub App path is disabled in this plugin. Use the GitHub Actions workflow for /megalens:review.',
  appNoToken: `Not signed in to MegaLens. Run \`npx @megalens/mcp setup\` (browser sign-in) or set MEGALENS_TOKEN and restart Claude Code to use the GitHub App review path (or set it up at ${APP_INSTALL_URL}).`,
  appUnauthorized: 'Your MegaLens sign-in token was rejected. Sign in again (`npx @megalens/mcp setup`) or update MEGALENS_TOKEN and restart Claude Code, then run this again.',
  appSuspended: `The MegaLens GitHub App installation for this repository is suspended on GitHub. Unsuspend it in GitHub settings, then run this again (or check ${APP_INSTALL_URL}).`,
  appNoticeRequired: `Finish MegaLens GitHub App setup to accept the review notice: ${APP_INSTALL_URL}`,
  appRangeUnsupported: `The MegaLens GitHub App reviews your open pull request or pushed commit rather than custom --base/--head ranges. Add ${WORKFLOW_PATH} (or pass --runner github / --runner local) to review an explicit range, or run /megalens:review without --base/--head.`,
  appEnterpriseUnsupported: (host) => `The MegaLens GitHub App only supports github.com repositories${host ? ` (this repository is on ${host})` : ''}. Add ${WORKFLOW_PATH} to run on your GitHub Actions runner (--runner github) or use --runner local.`,
  appBookmarkUnwritable: 'Cannot save the local review bookmark (the MegaLens state directory is unwritable or a symlink). Nothing was started and no credit was used. Fix permissions or MEGALENS_STATE_DIR, then run this again.',
};

export function workflowMissingMessage(branch) {
  return `The MegaLens workflow is not on your default branch (${branch}). Add this file as ${WORKFLOW_PATH} on ${branch}, commit it and push it, then run this again. GitHub only starts it from the default branch.\n\n--- ${WORKFLOW_PATH} ---\n${workflowText()}--- end of file ---\n`;
}

export function notPushedMessage(sha, branch) {
  return `NEEDS THE USER'S OK: your latest commit (${short(sha)}) is not on GitHub yet, and GitHub can only review what is on GitHub. Nothing was pushed. Ask the user: "Push ${branch || 'this branch'} to GitHub so it can be reviewed?" Only if the user says yes, run \`git push\` (if the branch has no upstream: \`git push -u origin HEAD\`), then run /megalens:review again. If the user says no, stop.\n`;
}

/** Verify gh is installed, logged in, and this folder has a GitHub repo. Retains host so GitHub Enterprise repos are never sent to github.com's App. */
async function ghRepoPreflight({ exec, cwd, env, signal = null }) {
  const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal });
  const v = await run('gh', ['--version']);
  if (v.code === 127) throw new GhUnavailableError(MSG.noGh);
  let au = await run('gh', ['auth', 'status', '--active']);
  if (au.code !== 0 && /unknown flag/i.test(au.stderr)) au = await run('gh', ['auth', 'status']);
  if (au.code !== 0) throw new SetupError(MSG.noLogin);
  const rv = await run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url']);
  const repo = rv.code === 0 ? jsonOf(rv.stdout) : null;
  if (!repo || typeof repo.nameWithOwner !== 'string' || !NWO_RE.test(repo.nameWithOwner) || typeof repo.defaultBranchRef?.name !== 'string') throw new SetupError(MSG.noRemote);
  const nwo = repo.nameWithOwner; const defaultBranch = repo.defaultBranchRef.name;
  if (!/^[\w./-]{1,100}$/.test(defaultBranch)) throw new SetupError(MSG.noRemote);
  const envHost = typeof env?.GH_HOST === 'string' && env.GH_HOST.trim() ? env.GH_HOST.trim().toLowerCase() : '';
  let host = null;
  let isGithubCom = false;
  if (typeof repo.url === 'string' && repo.url.trim()) {
    try {
      const u = new URL(repo.url.trim());
      host = u.hostname.toLowerCase();
      const cleanPath = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
      isGithubCom = u.protocol === 'https:'
        && host === 'github.com'
        && cleanPath.toLowerCase() === nwo.toLowerCase()
        && (!envHost || envHost === 'github.com');
    } catch {
      host = null;
      isGithubCom = false;
    }
  } else if (envHost) {
    host = envHost;
    isGithubCom = false;
  }
  return { nwo, defaultBranch, host, isGithubCom, hasGh: true };
}

/** Resolve the App repository from origin. An installed gh can still look up PRs even if auth status fails for another host. */
async function gitRepoFallback({ exec, cwd, env, signal = null, ghError }) {
  const envHost = typeof env?.GH_HOST === 'string' && env.GH_HOST.trim() ? env.GH_HOST.trim().toLowerCase() : '';
  if (envHost && envHost !== 'github.com') return null;
  const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd, env: ghEnv(env), signal });
  if (r.code !== 0) return null;
  const nwo = parseGitHubRemote(r.stdout.trim());
  return nwo ? { nwo, defaultBranch: null, host: 'github.com', isGithubCom: true, hasGh: !(ghError instanceof GhUnavailableError) } : null;
}

/**
 * Verify that the current checkout still belongs to the saved `github.com` App repository before
 * reading a saved App bookmark in no-ID `/megalens:status` or `/megalens:result`.
 * Prevents a checkout moved to GitHub Enterprise (or another repo) from querying `https://megalens.ai`.
 */
export async function verifyAppBookmarkRepo({ exec = realExec, cwd, env, saved, signal = null }) {
  if (!saved || saved.runner !== 'app') return { valid: true };
  let repo = null;
  try {
    repo = await ghRepoPreflight({ exec, cwd, env, signal });
  } catch (e) {
    if (e instanceof SetupError) {
      repo = await gitRepoFallback({ exec, cwd, env, signal, ghError: e });
    } else {
      throw e;
    }
  }
  if (signal?.aborted) return { valid: false, aborted: true };
  if (!repo || !repo.isGithubCom) return { valid: false };
  if (saved.nwo && repo.nwo.toLowerCase() !== saved.nwo.toLowerCase()) return { valid: false };
  return { valid: true, repo };
}

/** True when the dispatch workflow file is present on the default branch. */
export async function hasDispatchWorkflow({ exec, cwd, env, nwo, defaultBranch, signal = null }) {
  if (!defaultBranch) return false;
  const wf = await exec('gh', ['api', '-X', 'GET', `repos/${nwo}/contents/${WORKFLOW_PATH}`, '-f', `ref=${defaultBranch}`, '--jq', '.type'], { cwd, env: ghEnv(env), signal });
  return wf.code === 0 && wf.stdout.trim() === 'file';
}

/**
 * Query GET /api/github-app/status?repo=<owner/name> using MEGALENS_TOKEN.
 * Never throws; returns a structured status describing whether the App is ready, not installed, or blocked.
 */
export async function checkAppStatus({ env, nwo, fetch = globalThis.fetch, signal = null }) {
  const token = extractAppToken(env);
  if (!token) return { state: 'no_token', ready: false, installed: false, linked: false, noticeAccepted: false, suspended: false };
  const base = resolveAppApiBase(env);
  if (base.error) return { state: 'bad_url', ready: false, error: base.error };
  const res = await appApiRequest({
    origin: base.origin,
    token,
    method: 'GET',
    pathname: `/api/github-app/status?repo=${encodeURIComponent(nwo)}`,
    env,
    fetchImpl: fetch,
    signal,
  });
  if (res.aborted) return { state: 'aborted', ready: false };
  if (res.ok) {
    const installed = res.data.installed === true;
    const linked = res.data.linked === true;
    const noticeAccepted = res.data.notice_accepted === true;
    const suspended = res.data.suspended === true;
    const ready = installed && linked && noticeAccepted && !suspended;
    return { state: 'ok', ready, installed, linked, noticeAccepted, suspended };
  }
  if (res.status === 404) {
    return { state: 'unavailable_flag', ready: false, installed: false, linked: false, noticeAccepted: false, suspended: false };
  }
  if (res.status === 401) {
    return { state: 'unauthorized', ready: false, error: MSG.appUnauthorized };
  }
  if (res.status === 429) {
    const waitHint = res.retryAfterSec ? ` Try again in ${formatDurationSec(res.retryAfterSec)}.` : ' Wait a minute and try again.';
    return { state: 'error', ready: false, error: `Too many requests to MegaLens.${waitHint}` };
  }
  const detail = res.networkError || (res.errorCode ? `MegaLens returned ${res.errorCode}` : `HTTP ${res.status || 'error'}`);
  return { state: 'error', ready: false, error: `Could not reach MegaLens to check GitHub App status (${detail}). Try again in a moment.` };
}

/**
 * Automatically pick the remote runner for this repository:
 *   1. The MegaLens GitHub App when enabled and installed/linked/ready for this repo;
 *   2. Else the user's GitHub Actions runner when `.github/workflows/megalens-dispatch.yml` is present;
 *   3. Else `none` with one clear setup line.
 */
export async function detectRemoteRunner({ exec, cwd, env, fetch = globalThis.fetch, signal = null, needWorkflow = false, preRepo = null }) {
  let repo = preRepo ?? null;
  let ghErr = null;
  if (!repo) {
    try {
      repo = await ghRepoPreflight({ exec, cwd, env, signal });
    } catch (e) {
      if (e instanceof SetupError) ghErr = e;
      else throw e;
    }
  }

  // App-only setups can use the git origin when gh cannot identify the repository.
  if (!repo) {
    if (APP_PATH_ENABLED && extractAppToken(env)) {
      const gitRepo = await gitRepoFallback({ exec, cwd, env, signal, ghError: ghErr });
      if (gitRepo) {
        const appSt = await checkAppStatus({ env, nwo: gitRepo.nwo, fetch, signal });
        if (signal?.aborted || appSt.state === 'aborted') {
          return { runner: 'none', message: 'Interrupted before starting a review. Nothing was started by this command.' };
        }
        if (appSt.ready) return { runner: 'app', ...gitRepo, hasWorkflow: false };
        if (appSt.state === 'ok' && appSt.installed && appSt.linked) {
          return { runner: 'none', message: appSt.suspended ? MSG.appSuspended : MSG.appNoticeRequired };
        }
        if (appSt.state === 'ok') {
          return { runner: 'none', message: MSG.notSetup };
        }
        if (appSt.state === 'bad_url' || appSt.state === 'unauthorized' || appSt.state === 'error') {
          return { runner: 'none', message: appSt.error };
        }
      }
    }
    return { runner: 'none', message: ghErr.message };
  }

  const { nwo, defaultBranch, host, isGithubCom } = repo;
  let appSt = null;
  if (APP_PATH_ENABLED && isGithubCom && extractAppToken(env)) {
    appSt = await checkAppStatus({ env, nwo, fetch, signal });
    if (signal?.aborted || appSt.state === 'aborted') {
      return { runner: 'none', message: 'Interrupted before starting a review. Nothing was started by this command.' };
    }
    if (appSt.ready) {
      const hasWorkflow = needWorkflow
        ? await hasDispatchWorkflow({ exec, cwd, env, nwo, defaultBranch, signal })
        : false;
      return { runner: 'app', nwo, defaultBranch, host, isGithubCom, hasGh: true, hasWorkflow };
    }
    // Require a definitive fallback signal (App uninstalled/unlinked or feature flag off/404) before checking Actions.
    // A transient 503/429/network outage or auth/setup block on a linked repo must NEVER fall through to dispatch Actions.
    const definitiveFallback = appSt.state === 'unavailable_flag'
      || (appSt.state === 'ok' && (!appSt.installed || !appSt.linked));
    if (!definitiveFallback) {
      if (appSt.state === 'ok' && appSt.installed && appSt.linked) {
        return { runner: 'none', message: appSt.suspended ? MSG.appSuspended : MSG.appNoticeRequired };
      }
      return { runner: 'none', message: appSt.error || MSG.notSetup };
    }
  }

  const hasWorkflow = await hasDispatchWorkflow({ exec, cwd, env, nwo, defaultBranch, signal });
  if (hasWorkflow) return { runner: 'github', nwo, defaultBranch, host, isGithubCom, hasGh: true, hasWorkflow: true };

  if (!isGithubCom && host && host !== 'github.com') {
    return { runner: 'none', message: MSG.appEnterpriseUnsupported(host) };
  }
  return { runner: 'none', message: MSG.notSetup };
}

async function worktreeDirty(run) {
  const status = await run('git', ['status', '--porcelain', '--untracked-files=normal']);
  if (status.code !== 0) throw new SetupError(MSG.worktreeUnknown);
  return Boolean(status.stdout.trim());
}

/** Everything the GitHub Actions runner needs before it starts. Throws SetupError with a message naming the exact fix. */
export async function preflight({ exec, cwd, env, base = null, head = null, preRepo = null, signal = null }) {
  const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal });
  const { nwo, defaultBranch } = preRepo ?? await ghRepoPreflight({ exec, cwd, env, signal });

  if (!preRepo && !(await hasDispatchWorkflow({ exec, cwd, env, nwo, defaultBranch, signal }))) throw new SetupError(workflowMissingMessage(defaultBranch));

  let note = '';
  const sl = await run('gh', ['secret', 'list', '--json', 'name', '-R', nwo]);
  const names = sl.code === 0 ? jsonOf(sl.stdout) : null;
  const NO_PERMISSION = /HTTP 403|HTTP 404|Resource not accessible|not accessible by integration|must have admin/i;
  if (Array.isArray(names)) {
    if (!names.some((s) => s?.name === SECRET_NAME)) {
      const og = await run('gh', ['api', '-X', 'GET', `repos/${nwo}/actions/organization-secrets`, '-f', 'per_page=100', '--paginate', '--jq', '[.secrets[].name]']);
      let onames = null;
      if (og.code === 0) {
        const pages = og.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map(jsonOf);
        if (pages.length && pages.every(Array.isArray)) onames = pages.flat();
      }
      if (Array.isArray(onames)) { if (!onames.includes(SECRET_NAME)) throw new SetupError(MSG.noSecret); }
      else if (og.code !== 0 && /HTTP 404|not an organization|not found/i.test(og.stderr)) throw new SetupError(MSG.noSecret);
      else note = `${MSG.orgSecretUnknown}\n`;
    }
  }
  else if (NO_PERMISSION.test(sl.stderr)) note = `${MSG.secretUnknown}\n`;
  else throw new SetupError(MSG.secretCheckFailed(scrub(firstLine(sl.stderr), env)));

  const headRef = head ?? 'HEAD';
  const hs = await run('git', ['rev-parse', '--verify', `${headRef}^{commit}`]);
  const headSha = hs.stdout.trim();
  if (hs.code !== 0 || !SHA_RE.test(headSha)) throw new SetupError('Could not read the commit to review (is this a git repository with a commit?).');
  let baseSha = '';
  for (const b of base ? [base] : [`origin/${defaultBranch}`, defaultBranch]) {
    const mb = await run('git', ['merge-base', headSha, b]);
    if (mb.code === 0 && SHA_RE.test(mb.stdout.trim())) { baseSha = mb.stdout.trim(); break; }
  }
  if (!baseSha) throw new SetupError(`Could not find where this work branches off ${defaultBranch}. Run \`git fetch origin ${defaultBranch}\` and try again.`);
  if (baseSha === headSha) throw new SetupError(`Nothing to review: ${short(headSha)} is the same commit as the default branch (${defaultBranch}), so there is no change between them. Commit your work on a branch first.`);

  if (await worktreeDirty(run)) {
    if (base === null && head === null) throw new SetupError(MSG.dirtyStop);
    note += `${MSG.uncommitted}\n`;
  }

  const onGh = await run('gh', ['api', `repos/${nwo}/commits/${headSha}`, '--jq', '.sha']);
  if (onGh.code !== 0 || onGh.stdout.trim() !== headSha) {
    const br = await run('git', ['branch', '--show-current']);
    const bn = br.stdout.trim();
    throw new SetupError(notPushedMessage(headSha, /^[\w./-]{1,100}$/.test(bn) ? bn : ''), { needsUser: true });
  }
  return { nwo, defaultBranch, baseSha, headSha, note };
}

export const runTitle = (tier, baseSha, headSha) => `MegaLens ${tier} ${baseSha}..${headSha}`;

function workflowRange(title) {
  const match = typeof title === 'string' && /^MegaLens (?:standard|deep) (?<base>[0-9a-f]{40})\.\.(?<head>[0-9a-f]{40})$/.exec(title);
  return match && match[0] === title ? match.groups : null;
}

function reviewedRangeLine(title, id) {
  const range = workflowRange(title);
  return range ? `Reviewed ${short(range.base)}..${short(range.head)}\n` : `Commit range unavailable for gh:${id}.\n`;
}

const listRuns = async (run, nwo, limit = 50) => {
  const l = await run('gh', ['run', 'list', '--workflow', WORKFLOW_FILE, '--event', 'workflow_dispatch', '--limit', String(limit), '--json', 'databaseId,displayTitle,createdAt,url', '-R', nwo]);
  const rows = l.code === 0 ? jsonOf(l.stdout) : null;
  return Array.isArray(rows) ? rows.filter((x) => x && Number.isInteger(x.databaseId)) : null;
};

/**
 * Start the workflow run and find the id it created. Run ids that exist before the dispatch are recorded; only a NEW run
 * whose title is exactly "MegaLens <tier> <base>..<head>" counts. If dispatch is interrupted or fails ambiguously (not a
 * definitive GitHub 4xx refusal), reconciles against GitHub before reporting so a retry cannot double-charge.
 */
export async function startRun({
  exec,
  cwd,
  env,
  tier,
  pre,
  sleepMs = 2000,
  tries = 15,
  sleep = defaultSleep,
  signal = null,
  reconcileTimeoutMs = 4000,
  now = () => Date.now(),
  t0 = now(),
  waitMs = Infinity,
}) {
  const remaining = () => (Number.isFinite(waitMs) ? Math.max(0, waitMs - Math.max(0, now() - t0)) : Infinity);
  const preList = await raceWithDeadline(
    (callSignal) => listRuns((cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal: callSignal }), pre.nwo),
    { signal, remainingMs: remaining(), now, t0, waitMs },
  );
  if (preList.interrupted === 'aborted' || signal?.aborted) {
    throw new SetupError('Interrupted before starting the workflow. Nothing was started and no credit was used.');
  }
  if (preList.interrupted === 'timeout') {
    throw new SetupError('Timed out before starting the workflow. Nothing was started and no credit was used.');
  }
  const before = preList.value;
  if (before === null) throw new SetupError('Could not list the existing workflow runs, so a new run could not be told apart. Nothing was started and no credit was used. Check `gh auth status` and your network, then run this again.');
  const seen = new Set(before.map((x) => x.databaseId));
  const title = runTitle(tier, pre.baseSha, pre.headSha);
  const workflowUrl = `https://github.com/${pre.nwo}/actions/workflows/${WORKFLOW_FILE}`;

  const reconcileOnce = async () => {
    const lookup = await raceWithDeadline(
      (callSignal) => listRuns((cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal: callSignal }), pre.nwo),
      { remainingMs: Math.min(reconcileTimeoutMs, remaining()) },
    );
    const rows = lookup.value;
    if (!rows) return { status: 'error' };
    const hits = rows.filter((x) => !seen.has(x.databaseId) && x.displayTitle === title);
    if (hits.length === 1) {
      const hit = hits[0];
      return {
        status: 'found',
        run: {
          id: `gh:${hit.databaseId}`,
          url: typeof hit.url === 'string' ? hit.url : `https://github.com/${pre.nwo}/actions/runs/${hit.databaseId}`,
          createdAt: typeof hit.createdAt === 'string' ? hit.createdAt : null,
        },
      };
    }
    if (hits.length > 1) return { status: 'ambiguous' };
    return { status: 'none' };
  };

  const dispatchRes = await raceWithDeadline(
    (callSignal) => exec('gh', ['workflow', 'run', WORKFLOW_FILE, '--ref', pre.defaultBranch, '-f', `tier=${tier}`, '-f', `base_sha=${pre.baseSha}`, '-f', `head_sha=${pre.headSha}`, '-R', pre.nwo], { cwd, env: ghEnv(env), signal: callSignal }),
    { signal, remainingMs: remaining(), now, t0, waitMs },
  );
  const r = dispatchRes.interrupted ? { code: 4, stdout: '', stderr: '', aborted: true } : dispatchRes.value;
  const wasAborted = Boolean(dispatchRes.interrupted === 'aborted' || r.aborted || signal?.aborted);
  const wasTimedOut = dispatchRes.interrupted === 'timeout';
  if (r.code !== 0 || wasAborted || wasTimedOut) {
    if (!wasAborted && !wasTimedOut && DEFINITIVE_DISPATCH_REFUSAL_RE.test(r.stderr || '')) {
      throw new SetupError(`GitHub did not start the workflow: ${scrub(firstLine(r.stderr), env) || 'no reason given'}. Check that ${WORKFLOW_PATH} is on ${pre.defaultBranch} and that you can run workflows in this repository.`);
    }
    const rec = await reconcileOnce();
    if (rec.status === 'found') {
      return { ...rec.run, aborted: wasAborted, timedOut: wasTimedOut };
    }
    if (wasAborted || wasTimedOut) {
      throw new SetupError(`${wasTimedOut ? 'Timed out' : 'Interrupted'} while starting the workflow on GitHub. A review may already have been started and charged: do NOT start another one. Open ${workflowUrl} to check for the run (or run /megalens:status in a moment).`);
    }
    throw new SetupError(`The workflow dispatch did not finish cleanly (${scrub(firstLine(r.stderr), env) || 'no reason given'}). A review may already have been started and charged: do NOT start another one. Open ${workflowUrl} to check before retrying.`);
  }
  for (let i = 0; i < tries && !signal?.aborted && remaining() > 0; i++) {
    const listed = await raceWithDeadline(
      (callSignal) => listRuns((cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal: callSignal }), pre.nwo),
      { signal, remainingMs: remaining(), now, t0, waitMs },
    );
    if (listed.interrupted) {
      const rec = await reconcileOnce();
      if (rec.status === 'found') return { ...rec.run, aborted: listed.interrupted === 'aborted', timedOut: listed.interrupted === 'timeout' };
      return { id: null, url: workflowUrl, createdAt: null, aborted: listed.interrupted === 'aborted', timedOut: listed.interrupted === 'timeout' };
    }
    const rows = listed.value;
    if (rows) {
      const hits = rows.filter((x) => !seen.has(x.databaseId) && x.displayTitle === title);
      if (hits.length === 1) {
        const hit = hits[0];
        return {
          id: `gh:${hit.databaseId}`,
          url: typeof hit.url === 'string' ? hit.url : `https://github.com/${pre.nwo}/actions/runs/${hit.databaseId}`,
          createdAt: typeof hit.createdAt === 'string' ? hit.createdAt : null,
          aborted: false,
          timedOut: false,
        };
      }
      if (hits.length > 1) break;
    }
    const rem = remaining();
    if (rem <= 0 || signal?.aborted) break;
    await sleep(Math.min(sleepMs, rem), signal);
  }
  if (signal?.aborted || remaining() <= 0) {
    const rec = await reconcileOnce();
    if (rec.status === 'found') return { ...rec.run, aborted: Boolean(signal?.aborted), timedOut: !signal?.aborted && remaining() <= 0 };
  }
  return { id: null, url: workflowUrl, createdAt: null, aborted: Boolean(signal?.aborted), timedOut: !signal?.aborted && remaining() <= 0 };
}

/** gh run state -> queued / running / done / failed. */
export function mapState(status, conclusion) {
  const s = String(status ?? ''); const c = String(conclusion ?? '');
  if (s === 'completed') return c === 'success' ? 'done' : 'failed';
  if (['in_progress'].includes(s)) return 'running';
  if (['queued', 'waiting', 'pending', 'requested'].includes(s)) return 'queued';
  return 'failed';
}

/** The repository gh works in, resolved once; every later call names it with -R. Null when gh cannot tell. */
async function repoOf({ exec, cwd, env, signal = null }) {
  const rv = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd, env: ghEnv(env), signal });
  const j = rv.code === 0 ? jsonOf(rv.stdout) : null;
  return typeof j?.nameWithOwner === 'string' && NWO_RE.test(j.nameWithOwner) ? j.nameWithOwner : null;
}
const scoped = (args, nwo) => (nwo ? [...args, '-R', nwo] : args);

async function viewRun({ exec, cwd, env, signal = null }, id, nwo = null) {
  const r = await exec('gh', scoped(['run', 'view', id, '--json', 'status,conclusion,url,workflowName,displayTitle'], nwo), { cwd, env: ghEnv(env), signal });
  if (r.aborted || signal?.aborted) return { aborted: true };
  const j = r.code === 0 ? jsonOf(r.stdout) : null;
  if (!j || typeof j.status !== 'string') {
    return {
      error: `Could not read run gh:${id}: ${scrub(firstLine(r.stderr), env) || 'no usable answer from gh'}. Check the id, that you are in the same repository, and \`gh auth status\`. This is not a finished review.\n`,
      retryable: true,
    };
  }
  if (j.workflowName !== WORKFLOW_NAME) return { error: `gh:${id} is not a MegaLens review run. Nothing was read from it.\n` };
  return { j };
}

export async function runnerStatus(ctx, rawId, { showId = true, showRange = false } = {}) {
  const id = runIdOf(rawId);
  const nwo = ctx.nwo ?? await repoOf(ctx);
  if (ctx.signal?.aborted) return { text: '', code: 4, state: 'aborted' };
  const v = await viewRun(ctx, id, nwo);
  if (v.aborted) return { text: '', code: 4, state: 'aborted' };
  if (v.error) return { text: v.error, code: 4, state: 'error', retryable: v.retryable };
  const state = mapState(v.j.status, v.j.conclusion); const url = String(v.j.url ?? '').slice(0, 300);
  const rangeLine = showRange ? reviewedRangeLine(v.j.displayTitle, id) : '';
  if (!showId && state !== 'failed') {
    const shortWords = {
      queued: `Queued on GitHub. ${STILL_RUNNING_LINE}\n`,
      running: `${STILL_RUNNING_LINE}\n`,
      done: 'Finished. Run /megalens:result to see it.\n',
    }[state];
    return { text: shortWords + rangeLine, code: 0, state };
  }
  const words = {
    queued: 'Queued: GitHub has not started it yet. Check again in a minute.',
    running: `Running. Check again with /megalens:status gh:${id}.`,
    done: `Done. Fetch it with /megalens:result gh:${id}.`,
    failed: `FAILED: the run did not finish successfully (${scrub(String(v.j.conclusion ?? v.j.status), ctx.env).slice(0, 40)}). It is not a clean review and says nothing about your change. /megalens:result gh:${id} shows what was recorded, if anything.`,
  }[state];
  return { text: `Review gh:${id}: ${state}. ${words}\nRun: ${url}\n${rangeLine}`, code: 0, state };
}

export async function runnerResult(ctx, rawId, { showId = true, showRange = false } = {}) {
  const id = runIdOf(rawId);
  const nwo = ctx.nwo ?? await repoOf(ctx);
  if (ctx.signal?.aborted) return { text: '', code: 4, aborted: true };
  const v = await viewRun(ctx, id, nwo);
  if (v.aborted) return { text: '', code: 4, aborted: true };
  if (v.error) return { text: v.error, code: 4 };
  const state = mapState(v.j.status, v.j.conclusion);
  const rangeLine = showRange ? reviewedRangeLine(v.j.displayTitle, id) : '';
  if (state === 'queued' || state === 'running') {
    const msg = showId
      ? `That review is still ${state === 'queued' ? 'queued' : 'running'}, so there is no result yet. Nothing has been found or ruled out. Check with /megalens:status gh:${id}.\n`
      : `${STILL_RUNNING_LINE}\n`;
    return { text: msg + rangeLine, code: 4 };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'megalens-'), { mode: 0o700 });
  try {
    const d = await ctx.exec('gh', scoped(['run', 'download', id, '-n', ARTIFACT_NAME, '-D', dir], nwo), { cwd: ctx.cwd, env: ghEnv(ctx.env), signal: ctx.signal ?? null });
    if (d.aborted || ctx.signal?.aborted) return { text: '', code: 4, aborted: true };
    let doc = null;
    const file = path.join(dir, 'findings.json');
    if (d.code === 0) { try { if (statSync(file).size <= MAX_FINDINGS) doc = JSON.parse(readFileSync(file, 'utf8')); } catch { doc = null; } }
    const valid = doc && typeof doc === 'object' && doc.schema === 'megalens.findings/v1' && Array.isArray(doc.findings);
    const passes = valid && Array.isArray(doc.passes) ? doc.passes : [];
    const eff = valid ? effectiveStatus(doc, passes, passes.filter((p) => p && p.status === 'failed'), state === 'done' ? 0 : 4) : 'failed';
    const ok = state === 'done' && valid && eff !== 'failed';
    const somethingWrong = !ok || eff !== 'complete';
    const text = scrub(renderResult(doc, {
      exit: state === 'done' ? 0 : 4,
      stderrText: doc ? '' : firstLine(d.stderr) || `no ${ARTIFACT_NAME} artifact on that run (it may have expired or never been written)`,
      showId: showId || somethingWrong,
    }), ctx.env);
    const url = String(v.j.url ?? '').slice(0, 300);
    const trailer = (showId || somethingWrong) ? `${somethingWrong && !showId ? `Review id: gh:${id}\n` : ''}Run: ${url}\n` : '';
    return { text: `${text}${trailer}${rangeLine}`, code: ok ? 0 : 4, doc };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * /megalens:review on the user's GitHub Actions runner:
 * Checks setup, starts the run, saves it as the latest review for this repo, then WAITS (up to 20 minutes by default)
 * streaming short progress lines and prints the result inline. No id is shown unless something goes wrong.
 */
export async function runnerReview({
  exec = realExec,
  cwd,
  env,
  tier,
  base = null,
  head = null,
  wait = true,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  progressMs = DEFAULT_PROGRESS_MS,
  now = () => Date.now(),
  t0 = now(),
  sleep = defaultSleep,
  sleepMs,
  tries,
  signal = null,
  onLine = null,
  saveLatest = null,
  showIdOnNoWait = false,
  preRepo = null,
}) {
  if (tier !== 'standard' && tier !== 'deep') return { text: 'The GitHub runner path runs the standard or deep tier.\n', code: 4 };
  const capMs = wait ? waitMs : Infinity;
  const remaining = () => (Number.isFinite(capMs) ? Math.max(0, capMs - Math.max(0, now() - t0)) : Infinity);
  let pre;
  try {
    const preRes = await raceWithDeadline(
      (callSignal) => preflight({ exec, cwd, env, base, head, preRepo, signal: callSignal }),
      { signal, remainingMs: remaining(), now, t0, waitMs: capMs },
    );
    if (preRes.interrupted === 'aborted') return { text: 'Interrupted before starting the workflow. Nothing was started and no credit was used.\n', code: 4, aborted: true };
    if (preRes.interrupted === 'timeout') return { text: 'Timed out before starting the workflow. Nothing was started and no credit was used.\n', code: 4, timedOut: true };
    pre = preRes.value;
  } catch (e) { if (e instanceof SetupError) return { text: e.message.endsWith('\n') ? e.message : `${e.message}\n`, code: 4, setup: true, needsUser: e.needsUser }; throw e; }
  let started;
  try { started = await startRun({ exec, cwd, env, tier, pre, sleepMs, tries, sleep, signal, now, t0, waitMs: capMs }); } catch (e) { if (e instanceof SetupError) return { text: `${e.message}\n`, code: 4, setup: true }; throw e; }
  let acc = '';
  const emit = (s) => { acc += s; onLine?.(s); };
  if (pre.note) emit(pre.note);
  if (!started.id) {
    const errText = `${MSG.notFound(started.url)}\n`;
    emit(errText);
    return { text: acc, code: 4, timedOut: Boolean(started.timedOut), aborted: Boolean(started.aborted) };
  }
  saveLatest?.({ id: started.id, runner: 'github', nwo: pre.nwo, tier, startedAt: parseTs(started.createdAt) || undefined });
  if (started.aborted || started.timedOut || signal?.aborted) {
    emit(`${STILL_RUNNING_LINE}\n`);
    return { text: acc, code: 0, id: started.id, timedOut: Boolean(started.timedOut), aborted: Boolean(started.aborted || signal?.aborted) };
  }
  if (!wait) {
    const noWaitMsg = showIdOnNoWait
      ? `Review of ${short(pre.baseSha)}..${short(pre.headSha)} in ${pre.nwo}, tier ${tier}, runs on your GitHub runner.\nReview started on GitHub: ${started.id}\nRun: ${started.url}\n${STILL_RUNNING_LINE}\n`
      : `Review started\n${STILL_RUNNING_LINE}\n`;
    emit(noWaitMsg);
    return { text: acc, code: 0, id: started.id };
  }
  const baseCtx = { exec, cwd, env, nwo: pre.nwo };
  const w = await waitForReview({
    poll: async (callSignal) => {
      const ctx = { ...baseCtx, signal: callSignal };
      const status = await runnerStatus(ctx, started.id, { showId: false });
      return status.retryable && !callSignal.aborted
        ? runnerStatus(ctx, started.id, { showId: false })
        : status;
    },
    onLine: emit,
    startedLine: 'Review started',
    queuedLine: 'Queued on GitHub...',
    runningLine: 'Running on GitHub...',
    waitMs,
    pollMs,
    progressMs,
    now,
    t0,
    sleep,
    signal,
  });
  if (w.finished && (w.last?.state === 'done' || w.last?.state === 'failed')) {
    const remainingMs = Math.max(0, waitMs - Math.max(0, now() - t0));
    const fetched = await raceWithDeadline(
      (callSignal) => runnerResult({ ...baseCtx, signal: callSignal }, started.id, { showId: false }),
      { signal, remainingMs, now, t0, waitMs },
    );
    if (fetched.interrupted || fetched.value?.aborted) {
      emit(`${STILL_RUNNING_LINE}\n`);
      return { text: acc, code: 0, id: started.id, timedOut: fetched.interrupted === 'timeout', aborted: fetched.interrupted === 'aborted' || Boolean(fetched.value?.aborted) };
    }
    const r = fetched.value;
    emit(r.text);
    return { text: acc, code: r.code, id: started.id };
  }
  if (w.finished && w.last?.state === 'error') {
    const errLine = w.last.text || `Could not read run ${started.id}.\n`;
    emit(errLine);
    return { text: acc, code: 4, id: started.id };
  }
  return { text: acc, code: 0, id: started.id, timedOut: w.timedOut, aborted: w.aborted };
}

// ---- MegaLens GitHub App on-demand API (our review machine) ----

/** Map a server job from GET /api/github-app/review-now/[id] to wait-loop / status states. */
export function mapAppJobState(job) {
  const s = String(job?.status ?? '');
  const rs = String(job?.result_status ?? '');
  if (s === 'queued') return 'queued';
  if (s === 'running') return 'running';
  if (s === 'done') {
    if (rs === 'complete') return 'done';
    if (rs === 'partial') return 'partial';
    return 'failed';
  }
  if (s === 'cancelled') return 'cancelled';
  return 'failed';
}

function describeAppSubmitError(res, { repo, prNumber = null, headSha = null }) {
  const code = res.errorCode;
  if (res.status === 401 || code === 'unauthorized') return MSG.appUnauthorized;
  if (res.status === 404 && code === 'target_not_found') {
    return 'MegaLens could not find that commit or pull request on GitHub. Make sure your latest commit is pushed, then run this again.';
  }
  if (res.status === 404) {
    return `The MegaLens GitHub App is not installed or linked for ${repo} on your account. Set it up at ${APP_INSTALL_URL}`;
  }
  if (res.status === 409 && code === 'installation_suspended') return MSG.appSuspended;
  if (res.status === 409 && code === 'notice_required') return MSG.appNoticeRequired;
  if (res.status === 409 && code === 'review_finishing') {
    const targetUrl = prNumber
      ? `https://github.com/${repo}/pull/${prNumber}`
      : (headSha ? `https://github.com/${repo}/commit/${headSha}` : `https://github.com/${repo}`);
    return `A MegaLens review for this change is already finishing on GitHub. Check the result directly on GitHub (${targetUrl}); do not run /megalens:review again for the same commit or it may start a second review.`;
  }
  if (res.status === 422 || code === 'target_unavailable') {
    return 'MegaLens cannot review this target on the GitHub App (commits must be pushed to a branch tip or default branch history with a parent commit, and pull requests must be open, non-draft, and in this repository).';
  }
  if (res.status === 429 && code === 'daily_cap') {
    const resetHint = res.retryAfterSec ? ` Try again in about ${formatDurationSec(res.retryAfterSec)} (after the daily UTC reset).` : ' Try again after the daily UTC reset.';
    return `This repository has reached its daily MegaLens App review limit.${resetHint}`;
  }
  if (res.status === 429) {
    const waitHint = res.retryAfterSec ? ` Wait ${formatDurationSec(res.retryAfterSec)} and try again.` : ' Wait a minute and try again.';
    return `Too many requests to MegaLens.${waitHint}`;
  }
  if (res.status === 400 || res.status === 413) {
    return 'MegaLens rejected the review request as invalid. Nothing was started and no credit was used.';
  }
  const detail = res.networkError || code || `HTTP ${res.status || 'error'}`;
  return `MegaLens could not start the review (${detail}).`;
}

function describeSkippedReason(reason, env) {
  switch (reason) {
    case 'not_set_up':
      return `MegaLens reviews are not turned on for this installation. Finish setup at ${APP_INSTALL_URL}.`;
    case 'repo_removed':
      return `This repository is no longer connected to the MegaLens GitHub App. Reconnect it at ${APP_INSTALL_URL}.`;
    case 'not_enabled':
      return 'MegaLens GitHub App reviews are not enabled for your account yet.';
    case 'reviews_off':
      return `MegaLens GitHub App reviews are turned off for your account. Turn them on again at ${APP_INSTALL_URL}.`;
    case 'stale_head':
      return 'The pull request changed, closed, or became a draft before the review started, so no review ran.';
    default: {
      const clean = reason ? scrub(oneLine(reason, 80), env) : '';
      return clean ? `The review was skipped by MegaLens (${clean}), so no review ran.` : 'The review was skipped by MegaLens, so no review ran.';
    }
  }
}

function describeFailedReason(reason, env) {
  switch (reason) {
    case 'timeout':
      return 'The review ran out of time before finishing. Nothing more was charged.';
    case 'worker_lost':
      return 'The MegaLens review machine stopped before finishing.';
    case 'repo_unavailable':
      return 'MegaLens could no longer read this repository on GitHub.';
    case 'publish_failed':
      return 'MegaLens could not publish the review result to GitHub.';
    case 'bad_findings':
      return 'The review engine returned an unreadable result.';
    case 'prepare_failed':
      return 'MegaLens could not prepare this review.';
    case 'review_failed':
      return 'The review failed before completing.';
    default: {
      const clean = reason ? scrub(oneLine(reason, 80), env) : '';
      return clean ? `The review did not complete (${clean}).` : 'The review did not complete.';
    }
  }
}

function renderAppJob(job, rawId, { env = {}, showId = false } = {}) {
  const status = String(job?.status ?? '');
  const tier = (job?.tier === 'standard' || job?.tier === 'deep') ? job.tier : '';
  const tierPrefix = tier ? `${tier} ` : '';
  const prUrl = validGithubUrl(job?.pr_url, 'pull') ? scrubExact(job.pr_url, env) : '';
  const checkUrl = validGithubUrl(job?.check_url, 'runs') ? scrubExact(job.check_url, env) : '';
  const trailerOf = (includeId) => {
    const lines = [];
    if (includeId) lines.push(`Review id: ${rawId}`);
    if (prUrl) lines.push(`PR: ${prUrl}`);
    if (checkUrl) lines.push(`Check: ${checkUrl}`);
    return lines.length ? `${lines.join('\n')}\n` : '';
  };

  if (status === 'queued' || status === 'running') {
    const msg = showId
      ? `Review ${rawId} is still ${status}, so there is no result yet. Nothing has been found or ruled out. Check with /megalens:status ${rawId}.\n`
      : `${STILL_RUNNING_LINE}\n`;
    return { text: msg, code: 4 };
  }

  if (status === 'no_credits') {
    const out = [
      `## MegaLens ${tierPrefix}review: NOT COMPLETED`,
      '',
      'Your MegaLens account is out of credits, so no review ran. This is not a clean review.',
      `Add credits at ${APP_BILLING_URL}, then run /megalens:review again.`,
    ].join('\n') + '\n';
    return { text: out + trailerOf(showId), code: 4 };
  }

  if (status === 'cancelled') {
    const why = job?.reason === 'superseded'
      ? 'A newer commit superseded this review before it finished.'
      : 'The review was cancelled before it completed.';
    const out = [
      `## MegaLens ${tierPrefix}review: CANCELLED`,
      '',
      `${why} This is not a clean review.`,
    ].join('\n') + '\n';
    return { text: out + trailerOf(showId), code: 4 };
  }

  if (status === 'skipped') {
    const out = [
      `## MegaLens ${tierPrefix}review: NOT COMPLETED`,
      '',
      `${describeSkippedReason(job?.reason, env)} This is not a clean review.`,
    ].join('\n') + '\n';
    return { text: out + trailerOf(showId), code: 4 };
  }

  const rawDoc = job?.findings;
  const validDoc = rawDoc && typeof rawDoc === 'object' && rawDoc.schema === 'megalens.findings/v1' && Array.isArray(rawDoc.findings);
  const doc = validDoc
    ? ((!['standard', 'deep', 'double'].includes(rawDoc.tier) && tier) ? { ...rawDoc, tier } : rawDoc)
    : null;

  if (status === 'done') {
    const rs = String(job?.result_status ?? '');
    if (rs === 'too_large') {
      const out = [
        `## MegaLens ${tierPrefix}review: NOT COMPLETED`,
        '',
        'The change was too large for MegaLens to review. Nothing was reviewed, so this is not a clean review. Split the change into smaller commits or pull requests and try again.',
      ].join('\n') + '\n';
      return { text: out + trailerOf(showId), code: 4 };
    }
    if (rs === 'stale') {
      const out = [
        `## MegaLens ${tierPrefix}review: NOT COMPLETED`,
        '',
        'The pull request changed before the review finished, so the result was discarded. This is not a clean review. Run /megalens:review again for the latest commit.',
      ].join('\n') + '\n';
      return { text: out + trailerOf(showId), code: 4 };
    }
    if (rs === 'complete' || rs === 'partial') {
      if (doc) {
        const exit = rs === 'partial' ? 2 : 0;
        const passes = Array.isArray(doc.passes) ? doc.passes : [];
        const eff = effectiveStatus(doc, passes, passes.filter((p) => p && p.status === 'failed'), exit);
        const somethingWrong = eff !== 'complete';
        const text = scrub(renderResult(doc, { exit, showId, hideId: !showId && eff === 'failed' }), env);
        const trailer = (showId || somethingWrong) ? trailerOf(showId) : '';
        const code = eff === 'complete' ? 0 : (eff === 'partial' ? 2 : 4);
        return { text: `${text}${trailer}`, code, doc };
      }
      if (rs === 'partial') {
        const out = [
          `## MegaLens ${tierPrefix}review: PARTIAL`,
          '',
          '**This review is partial**, and its findings are no longer stored on MegaLens (results are kept for 24 hours). This is not a clean review. Run /megalens:review to start a new review.',
        ].join('\n') + '\n';
        return { text: out + trailerOf(showId), code: 4 };
      }
      const out = [
        `## MegaLens ${tierPrefix}review: RESULT EXPIRED`,
        '',
        'The review completed, but its findings are no longer stored on MegaLens (results are kept for 24 hours). Run /megalens:review to start a new review.',
      ].join('\n') + '\n';
      return { text: out + trailerOf(showId), code: 4 };
    }
  }

  // status === 'failed', done with failed/unknown result_status, or unknown status: fail closed.
  if (doc) {
    const text = scrub(renderResult(doc, { exit: 4, showId, hideId: !showId }), env);
    return { text: `${text}${trailerOf(showId)}`, code: 4, doc };
  }
  const out = [
    `## MegaLens ${tierPrefix}review: FAILED`,
    '',
    `${describeFailedReason(job?.reason, env)} This is not a clean review.`,
  ].join('\n') + '\n';
  return { text: out + trailerOf(showId), code: 4 };
}

async function fetchAppJob({ env, fetch = globalThis.fetch, signal = null }, jobId, { showId = true } = {}) {
  const token = extractAppToken(env);
  if (!token) return { error: `${MSG.appNoToken}\n`, retryable: false };
  const base = resolveAppApiBase(env);
  if (base.error) return { error: `${base.error}\n`, retryable: false };
  const res = await appApiRequest({
    origin: base.origin,
    token,
    method: 'GET',
    pathname: `/api/github-app/review-now/${encodeURIComponent(jobId)}`,
    env,
    fetchImpl: fetch,
    signal,
  });
  if (res.aborted) return { aborted: true };
  const label = showId ? `MegaLens review app:${jobId}` : 'the MegaLens review';
  if (res.ok) {
    if (typeof res.data.status !== 'string') {
      return { error: `Could not read ${label}: unreadable status response. This is not a finished review.\n`, retryable: true };
    }
    return { job: res.data };
  }
  if (res.status === 401) return { error: `${MSG.appUnauthorized}\n`, retryable: false };
  if (res.status === 404) {
    const target = showId ? `review app:${jobId}` : 'that review';
    return { error: `MegaLens could not find ${target} (it may belong to another account, the App installation may have changed, or the id is wrong). This is not a finished review.\n`, retryable: false, notFound: true };
  }
  const detail = res.networkError || res.errorCode || `HTTP ${res.status || 'error'}`;
  return {
    error: `Could not read ${label} (${detail}). This is not a finished review.\n`,
    retryable: res.retryable,
    retryAfterSec: res.retryAfterSec,
  };
}

async function currentLocalHeadSha({ exec = realExec, cwd, env, signal = null }) {
  if (!exec || !cwd) return null;
  try {
    const hs = await exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, env: ghEnv(env ?? {}), signal });
    const sha = hs.code === 0 ? hs.stdout.trim().toLowerCase() : '';
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function parseJobPrUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]*)$/i.exec(url.trim());
  return m ? { nwo: m[1].toLowerCase(), prNumber: Number(m[2]) } : { invalid: true };
}

function jobMatchesTargetPr(job, nwo, prNumber) {
  const parsed = parseJobPrUrl(job?.pr_url);
  if (prNumber !== null) {
    if (!parsed) return true;
    return !parsed.invalid && parsed.nwo === nwo.toLowerCase() && parsed.prNumber === prNumber;
  }
  return parsed === null;
}

async function checkBookmarkHeadDrift(ctx, job, rawId, savedBookmark, saveLatest) {
  if (!savedBookmark) return null;
  const actualSha = normalizedJobHeadSha(job);
  if (!actualSha) return null;
  const driftedOnServer = Boolean(savedBookmark.headSha && actualSha !== savedBookmark.headSha);
  const previouslyDrifted = Boolean(savedBookmark.requestedHeadSha && actualSha !== savedBookmark.requestedHeadSha);
  if (!driftedOnServer && !previouslyDrifted) return null;
  const expectedSha = savedBookmark.requestedHeadSha || savedBookmark.headSha;
  const localHead = await currentLocalHeadSha(ctx);
  if (localHead && localHead === actualSha) {
    saveLatest?.({
      id: rawId,
      runner: 'app',
      nwo: savedBookmark.nwo,
      tier: job?.tier || savedBookmark.tier,
      headSha: actualSha,
      prNumber: savedBookmark.prNumber,
      prBaseSha: savedBookmark.prBaseSha,
      prBaseRef: savedBookmark.prBaseRef,
    });
    return null;
  }
  saveLatest?.({
    id: rawId,
    runner: 'app',
    nwo: savedBookmark.nwo,
    tier: job?.tier || savedBookmark.tier,
    headSha: actualSha,
    requestedHeadSha: expectedSha,
    prNumber: savedBookmark.prNumber,
    prBaseSha: savedBookmark.prBaseSha,
    prBaseRef: savedBookmark.prBaseRef,
  });
  return {
    text: describeHeadMismatch({
      tier: job?.tier || savedBookmark.tier,
      expectedSha: localHead || expectedSha,
      actualSha,
      nwo: savedBookmark.nwo,
      prNumber: savedBookmark.prNumber,
    }),
    code: 4,
    state: 'error',
    headMismatch: true,
  };
}

export async function appStatus(ctx, rawId, { showId = true, savedBookmark = null, saveLatest = null } = {}) {
  const id = appJobIdOf(rawId);
  if (ctx.signal?.aborted) return { text: '', code: 4, state: 'aborted' };
  const v = await fetchAppJob(ctx, id, { showId });
  if (v.aborted) return { text: '', code: 4, state: 'aborted' };
  if (v.error) return { text: v.error, code: 4, state: 'error', retryable: v.retryable, retryAfterSec: v.retryAfterSec, notFound: v.notFound };
  if (!showId && savedBookmark) {
    const mismatch = await checkBookmarkHeadDrift(ctx, v.job, `app:${id}`, savedBookmark, saveLatest);
    if (mismatch) return mismatch;
  }
  const state = mapAppJobState(v.job);
  const prUrl = validGithubUrl(v.job.pr_url, 'pull') ? scrubExact(v.job.pr_url, ctx.env) : '';
  const checkUrl = validGithubUrl(v.job.check_url, 'runs') ? scrubExact(v.job.check_url, ctx.env) : '';
  if (!showId && (state === 'queued' || state === 'running' || state === 'done')) {
    const shortWords = {
      queued: `Waiting for MegaLens review machine. ${STILL_RUNNING_LINE}\n`,
      running: `${STILL_RUNNING_LINE}\n`,
      done: 'Finished. Run /megalens:result to see it.\n',
    }[state];
    return { text: shortWords, code: 0, state, job: v.job };
  }
  const tier = (v.job.tier === 'standard' || v.job.tier === 'deep') ? ` (${v.job.tier})` : '';
  let words;
  if (v.job.status === 'no_credits') {
    words = `FAILED: your MegaLens account is out of credits, so no review ran. Add credits at ${APP_BILLING_URL}. This is not a clean review.`;
  } else if (v.job.status === 'skipped') {
    words = `FAILED: ${describeSkippedReason(v.job.reason, ctx.env)} This is not a clean review.`;
  } else if (state === 'queued') {
    words = 'Queued on MegaLens review machine.';
  } else if (state === 'running') {
    words = 'Running on MegaLens review machine.';
  } else if (state === 'done') {
    words = showId ? `Done. Fetch it with /megalens:result app:${id}.` : 'Finished. Run /megalens:result to see it.';
  } else if (state === 'partial') {
    words = 'PARTIAL: part of the review did not finish, so it is not a clean review.';
  } else if (state === 'cancelled') {
    words = 'CANCELLED: the review did not complete, so it is not a clean review.';
  } else {
    words = `FAILED: ${describeFailedReason(v.job.reason, ctx.env)} This is not a clean review.`;
  }
  const extraLinks = `${prUrl ? `\nPR: ${prUrl}` : ''}${checkUrl ? `\nCheck: ${checkUrl}` : ''}`;
  const prefix = showId ? `Review app:${id}${tier}: ${state}. ` : `MegaLens${tier} review: ${state}. `;
  return { text: `${prefix}${words}${extraLinks}\n`, code: 0, state, job: v.job };
}

export async function appResult(ctx, rawId, { showId = true, savedBookmark = null, saveLatest = null } = {}) {
  const id = appJobIdOf(rawId);
  if (ctx.signal?.aborted) return { text: '', code: 4, aborted: true };
  const v = await fetchAppJob(ctx, id, { showId });
  if (v.aborted) return { text: '', code: 4, aborted: true };
  if (v.error) return { text: v.error, code: 4 };
  if (!showId && savedBookmark) {
    const mismatch = await checkBookmarkHeadDrift(ctx, v.job, `app:${id}`, savedBookmark, saveLatest);
    if (mismatch) return { text: mismatch.text, code: 4 };
  }
  return renderAppJob(v.job, `app:${id}`, { env: ctx.env, showId });
}

const NO_PR_FOUND_RE = /^no pull requests? found(?: for branch(?: .+)?)?$/i;

function bookmarkMatchesPrBase(saved, pr) {
  return !pr || (Boolean(pr.baseSha) && saved.prBaseSha === pr.baseSha && (saved.prBaseRef ?? null) === pr.baseRef);
}

function describePrHeadBehind({ tier, expectedSha, prHeadSha, nwo, prNumber }) {
  const tierPrefix = (tier === 'standard' || tier === 'deep') ? `${tier} ` : '';
  return [
    `## MegaLens ${tierPrefix}review: NOT COMPLETED`,
    '',
    `Pull request #${prNumber} on GitHub is at commit ${short(prHeadSha)}, while your local checkout is at ${short(expectedSha)}. Nothing was started and no credit was used. Pull the latest changes (\`git pull\`) or push your branch, then run /megalens:review again (or check https://github.com/${nwo}/pull/${prNumber}). This is not a clean review.`,
  ].join('\n') + '\n';
}

/**
 * Look up an open, non-draft, same-repo PR on `github.com/<nwo>` for the checked-out branch.
 * Fails closed (`state: 'error'`) on transient GitHub/network errors (e.g. HTTP 502) so a PR lookup
 * outage never silently narrows a paid review to a single commit. Also returns `state: 'head_mismatch'`
 * when the open PR on GitHub has moved to a different head commit, and captures baseRefOid/baseRefName
 * so retargeting a PR invalidates stale clean bookmarks.
 */
async function detectOpenPr({ run, nwo, headSha, env = {} }) {
  const br = await run('git', ['branch', '--show-current']);
  if (br.aborted) return { state: 'aborted' };
  if (br.code !== 0) {
    const detail = scrubExact(firstLine(br.stderr), env) || 'git branch failed';
    return {
      state: 'error',
      error: `Could not read the current git branch (${detail}). Nothing was started and no credit was used. Resolve any Git errors and try again.`,
    };
  }
  const localBranch = br.stdout.trim();
  if (!localBranch) return { state: 'none' }; // detached HEAD
  const upstream = await run('git', ['for-each-ref', '--format=%(upstream:remotename)%09%(upstream:remoteref)', `refs/heads/${localBranch}`]);
  if (upstream.aborted) return { state: 'aborted' };
  if (upstream.code !== 0) {
    const detail = scrubExact(firstLine(upstream.stderr), env) || 'git for-each-ref failed';
    return {
      state: 'error',
      error: `Could not read the upstream git branch (${detail}). Nothing was started and no credit was used. Resolve any Git errors and try again.`,
    };
  }
  const [upstreamRemote, upstreamRef] = upstream.stdout.trimEnd().split('\t');
  const upstreamBranch = upstreamRef?.startsWith('refs/heads/') ? upstreamRef.slice('refs/heads/'.length) : null;
  if (upstreamRemote && upstreamRemote !== '.' && upstreamBranch && upstreamBranch !== localBranch) {
    const remote = await run('git', ['remote', 'get-url', '--', upstreamRemote]);
    if (remote.aborted) return { state: 'aborted' };
    if (remote.code !== 0) {
      return {
        state: 'error',
        error: 'Could not identify the upstream Git remote. Nothing was started and no credit was used. Check the Git remote configuration and try again.',
      };
    }
    if (parseGitHubRemote(remote.stdout)?.toLowerCase() === nwo.toLowerCase()) {
      const pr = await lookupOpenPr({ run, nwo, headSha, env, branch: upstreamBranch });
      if (pr.state !== 'none') return pr;
    }
  }
  // A pushed feature branch can still track its base branch.
  return lookupOpenPr({ run, nwo, headSha, env, branch: localBranch });
}

async function lookupOpenPr({ run, nwo, headSha, env, branch }) {
  if (branch.startsWith('-') || !/^[\w./@+-]{1,100}$/.test(branch)) {
    return {
      state: 'error',
      error: 'Could not look up an open pull request for this branch name. Nothing was started and no credit was used.',
    };
  }
  // gh treats a bare numeric selector as a PR number. An owner prefix makes it a branch selector.
  const selector = /^\+?\d+$/.test(branch) ? `${nwo.split('/')[0]}:${branch}` : branch;
  const prRes = await run('gh', [
    'pr', 'view', selector,
    '-R', `github.com/${nwo}`,
    '--json', 'number,state,isDraft,headRefOid,baseRefOid,baseRefName,isCrossRepository,url',
  ]);
  if (prRes.aborted) return { state: 'aborted' };
  if (prRes.code !== 0) {
    if (prRes.code === 1 && NO_PR_FOUND_RE.test((prRes.stderr || prRes.stdout).trim())) return { state: 'none' };
    const detail = scrubExact(firstLine(prRes.stderr || prRes.stdout), env) || 'gh pr view failed';
    return {
      state: 'error',
      error: `Could not check whether branch ${branch} has an open pull request on GitHub (${detail}). Nothing was started and no credit was used. Try again in a moment.`,
    };
  }
  const pr = jsonOf(prRes.stdout);
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr?.state) || typeof pr.isDraft !== 'boolean' || typeof pr.isCrossRepository !== 'boolean' || typeof pr.url !== 'string' || !pr.url.trim()) {
    return {
      state: 'error',
      error: `Could not read the pull request details from GitHub for branch ${branch}. Nothing was started and no credit was used. Try again in a moment.`,
    };
  }
  const num = pr.number;
  if (!Number.isInteger(num) || num <= 0 || num > 2_147_483_647) {
    return {
      state: 'error',
      error: `GitHub returned an invalid pull request number for branch ${branch}. Nothing was started and no credit was used. Try again in a moment.`,
    };
  }
  if (pr.state !== 'OPEN') return { state: 'none' };
  if (pr.isDraft === true || pr.isCrossRepository === true) return { state: 'none' };
  if (pr.url.trim().toLowerCase() !== `https://github.com/${nwo.toLowerCase()}/pull/${num}`) {
    return { state: 'none' };
  }
  const prHeadSha = typeof pr.headRefOid === 'string' && SHA_RE.test(pr.headRefOid.trim())
    ? pr.headRefOid.trim().toLowerCase()
    : null;
  if (!prHeadSha) {
    return {
      state: 'error',
      error: `GitHub returned an invalid head commit for pull request #${num}. Nothing was started and no credit was used. Try again in a moment.`,
    };
  }
  const baseSha = typeof pr.baseRefOid === 'string' && SHA_RE.test(pr.baseRefOid.trim())
    ? pr.baseRefOid.trim().toLowerCase()
    : null;
  if (!baseSha) {
    return {
      state: 'error',
      error: `GitHub returned an invalid base commit for pull request #${num}. Nothing was started and no credit was used. Try again in a moment.`,
    };
  }
  const baseRef = typeof pr.baseRefName === 'string' && /^[\w./@+-]{1,100}$/.test(pr.baseRefName.trim())
    ? pr.baseRefName.trim()
    : null;
  const info = { number: num, headSha: prHeadSha, baseSha, baseRef };
  if (prHeadSha !== headSha) return { state: 'head_mismatch', pr: info };
  return { state: 'open', pr: info };
}

export async function appPreflight({ exec, cwd, env, tier = 'standard', preRepo = null, base = null, head = null, signal = null }) {
  if (base !== null) throw new SetupError(MSG.appRangeUnsupported);
  const token = extractAppToken(env);
  if (!token) throw new SetupError(MSG.appNoToken);
  const apiBase = resolveAppApiBase(env);
  if (apiBase.error) throw new SetupError(apiBase.error);

  const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal });
  let repo = preRepo?.nwo
    ? {
        nwo: preRepo.nwo,
        defaultBranch: preRepo.defaultBranch ?? null,
        host: preRepo.host ?? 'github.com',
        isGithubCom: preRepo.isGithubCom !== false && (!preRepo.host || preRepo.host === 'github.com'),
        hasGh: preRepo.hasGh !== false,
      }
    : null;
  if (!repo) {
    try {
      repo = await ghRepoPreflight({ exec, cwd, env, signal });
    } catch (e) {
      if (e instanceof SetupError) {
        const gitRepo = await gitRepoFallback({ exec, cwd, env, signal, ghError: e });
        if (!gitRepo) throw e;
        repo = gitRepo;
      } else {
        throw e;
      }
    }
  }
  if (!repo.isGithubCom) {
    throw new SetupError(MSG.appEnterpriseUnsupported(repo.host));
  }

  const headRef = head ?? 'HEAD';
  const hs = await run('git', ['rev-parse', '--verify', `${headRef}^{commit}`]);
  const headSha = hs.stdout.trim().toLowerCase();
  if (hs.code !== 0 || !SHA_RE.test(headSha)) throw new SetupError('Could not read the commit to review (is this a git repository with a commit?).');

  let note = '';
  if (await worktreeDirty(run)) {
    if (base === null && head === null) throw new SetupError(MSG.dirtyStop);
    note += `${MSG.uncommitted}\n`;
  }

  let prNumber = null;
  let prBaseSha = null;
  let prBaseRef = null;
  if (repo.hasGh) {
    const prInfo = await detectOpenPr({ run, nwo: repo.nwo, headSha, env });
    if (prInfo.state === 'error') throw new SetupError(prInfo.error);
    if (prInfo.state === 'aborted') throw new SetupError('Interrupted before starting the review. Nothing was started and no credit was used.');
    const onGh = await run('gh', ['api', '--hostname', 'github.com', `repos/${repo.nwo}/commits/${headSha}`, '--jq', '.sha']);
    if (onGh.code !== 0 || onGh.stdout.trim().toLowerCase() !== headSha) {
      const br = await run('git', ['branch', '--show-current']);
      const bn = br.stdout.trim();
      throw new SetupError(notPushedMessage(headSha, /^[\w./-]{1,100}$/.test(bn) ? bn : ''), { needsUser: true });
    }
    if (prInfo.state === 'head_mismatch' && head === null) {
      throw new SetupError(describePrHeadBehind({ tier, expectedSha: headSha, prHeadSha: prInfo.pr.headSha, nwo: repo.nwo, prNumber: prInfo.pr.number }));
    }
    if (prInfo.state === 'open') {
      prNumber = prInfo.pr.number;
      prBaseSha = prInfo.pr.baseSha;
      prBaseRef = prInfo.pr.baseRef;
    }
  }

  return { nwo: repo.nwo, defaultBranch: repo.defaultBranch, host: repo.host, isGithubCom: true, hasGh: repo.hasGh, headSha, prNumber, prBaseSha, prBaseRef, note, origin: apiBase.origin, token };
}

/**
 * Submit a review to POST /api/github-app/review-now.
 * For immutable commit-SHA requests (`ref`), the server deduplicates identical in-flight and 24h retained
 * jobs per tier, so on a lost reply (network error / 5xx) we make at most one bounded retry.
 * For mutable PR requests (`pr`), the server resolves the PR's live head on every POST, so a lost reply
 * is NEVER auto-retried (which could start a second billable review if a teammate pushed in between).
 */
export async function startAppReview({
  pre,
  tier,
  env,
  fetch = globalThis.fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
  t0 = now(),
  waitMs = Infinity,
  signal = null,
  exec = null,
  cwd = null,
}) {
  const remaining = () => (Number.isFinite(waitMs) ? Math.max(0, waitMs - Math.max(0, now() - t0)) : Infinity);
  const isPrSubmit = pre.prNumber !== null;
  const payload = isPrSubmit
    ? { repo: pre.nwo, tier, pr: pre.prNumber }
    : { repo: pre.nwo, tier, ref: pre.headSha };
  const prUrl = isPrSubmit ? `https://github.com/${pre.nwo}/pull/${pre.prNumber}` : null;
  const unknownOutcomeHint = isPrSubmit
    ? `A review may already have been started on GitHub: do NOT start another one. Check ${prUrl} for the MegaLens review.`
    : 'A review may already be in flight: wait a moment and run /megalens:review again (MegaLens reuses an in-flight review for the same commit and tier instead of charging twice).';

  const submitOnce = () => raceWithDeadline(
    (callSignal) => appApiRequest({
      origin: pre.origin,
      token: pre.token,
      method: 'POST',
      pathname: '/api/github-app/review-now',
      body: payload,
      env,
      fetchImpl: fetch,
      signal: callSignal,
    }),
    { signal, remainingMs: remaining(), now, t0, waitMs },
  );

  let attempt = await submitOnce();
  if (attempt.interrupted) {
    const label = attempt.interrupted === 'timeout' ? 'Timed out' : 'Interrupted';
    return {
      ok: false,
      aborted: attempt.interrupted === 'aborted',
      timedOut: attempt.interrupted === 'timeout',
      text: `${label} while starting the review on MegaLens. ${unknownOutcomeHint}\n`,
    };
  }

  let res = attempt.value;
  // Lost reply (network drop / 5xx / unreadable body — NOT 429 rate-limited, and NEVER for mutable PR targets):
  // make at most one idempotent retry for an immutable commit SHA to recover the same job_id.
  const canRetryLostReply = !isPrSubmit && !res.ok && !res.aborted && res.retryable && res.status !== 429;
  if (canRetryLostReply && remaining() > 0 && !signal?.aborted) {
    const delayMs = Math.min(
      res.retryAfterSec ? Math.min(res.retryAfterSec * 1000, 10_000) : APP_LOST_REPLY_RETRY_MS,
      remaining(),
    );
    if (delayMs > 0) {
      const slept = await raceWithDeadline((callSignal) => sleep(delayMs, callSignal), {
        signal, remainingMs: remaining(), now, t0, waitMs,
      });
      if (slept.interrupted) {
        const label = slept.interrupted === 'timeout' ? 'Timed out' : 'Interrupted';
        return {
          ok: false,
          aborted: slept.interrupted === 'aborted',
          timedOut: slept.interrupted === 'timeout',
          text: `${label} while confirming whether MegaLens started the review. ${unknownOutcomeHint}\n`,
        };
      }
    }
    if (!signal?.aborted && remaining() > 0) {
      attempt = await submitOnce();
      if (attempt.interrupted) {
        const label = attempt.interrupted === 'timeout' ? 'Timed out' : 'Interrupted';
        return {
          ok: false,
          aborted: attempt.interrupted === 'aborted',
          timedOut: attempt.interrupted === 'timeout',
          text: `${label} while confirming whether MegaLens started the review. ${unknownOutcomeHint}\n`,
        };
      }
      res = attempt.value;
    }
  }

  if (res.aborted) {
    return {
      ok: false,
      aborted: true,
      timedOut: false,
      text: `Interrupted while starting the review on MegaLens. ${unknownOutcomeHint}\n`,
    };
  }

  if (res.ok) {
    const jobId = typeof res.data?.job_id === 'string' && APP_JOB_UUID_RE.test(res.data.job_id)
      ? res.data.job_id.toLowerCase()
      : null;
    if (!jobId) {
      return {
        ok: false,
        text: `MegaLens accepted the request but returned an invalid job id. ${unknownOutcomeHint}\n`,
      };
    }
    return { ok: true, id: `app:${jobId}`, jobId };
  }

  if (!pre.hasGh && exec && (res.status === 404 && res.errorCode === 'target_not_found' || res.status === 422)) {
    const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal });
    const contains = await run('git', ['branch', '-r', '--contains', pre.headSha]);
    if (contains.code === 0 && !contains.stdout.trim()) {
      const br = await run('git', ['branch', '--show-current']);
      const bn = br.stdout.trim();
      return { ok: false, needsUser: true, text: notPushedMessage(pre.headSha, /^[\w./-]{1,100}$/.test(bn) ? bn : '') };
    }
  }

  if (res.retryable && res.status !== 429) {
    const detail = res.networkError || res.errorCode || `HTTP ${res.status || 'error'}`;
    return {
      ok: false,
      text: `Could not confirm whether MegaLens started the review (${detail}). ${unknownOutcomeHint}\n`,
    };
  }

  return { ok: false, text: `${describeAppSubmitError(res, { repo: pre.nwo, prNumber: pre.prNumber, headSha: pre.headSha })}\n` };
}

function normalizedJobHeadSha(job) {
  return typeof job?.head_sha === 'string' && SHA_RE.test(job.head_sha.trim())
    ? job.head_sha.trim().toLowerCase()
    : null;
}

function describeHeadMismatch({ tier, expectedSha, actualSha, nwo, prNumber }) {
  const tierPrefix = (tier === 'standard' || tier === 'deep') ? `${tier} ` : '';
  const where = prNumber && nwo
    ? `Pull request #${prNumber} on GitHub moved to commit ${short(actualSha)} while your local checkout is at ${short(expectedSha)}. MegaLens reviewed commit ${short(actualSha)}, not your local commit, so those findings are not shown for ${short(expectedSha)}. Pull the latest changes (\`git pull\`) and run /megalens:result to view it, or check https://github.com/${nwo}/pull/${prNumber}.`
    : `MegaLens returned a review for commit ${short(actualSha)} instead of your local commit ${short(expectedSha)}, so those findings are not shown for ${short(expectedSha)}.`;
  return [
    `## MegaLens ${tierPrefix}review: NOT COMPLETED`,
    '',
    `${where} This is not a clean review.`,
  ].join('\n') + '\n';
}

/**
 * Read a saved App job, honouring Retry-After and exponential backoff on retryable errors (429/5xx/network)
 * across the active wait budget so a transient rate limit or gateway blip on the first read never exits 4 early.
 */
async function fetchAppJobWithRetry({
  env,
  fetch = globalThis.fetch,
  jobId,
  showId = false,
  wait = true,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = () => Date.now(),
  t0 = now(),
  sleep = defaultSleep,
  signal = null,
}) {
  const capMs = wait ? waitMs : Infinity;
  let transientErrors = 0;
  let sleptMs = 0;
  const elapsed = () => Math.max(0, now() - t0, sleptMs);
  const remaining = () => (Number.isFinite(capMs) ? Math.max(0, capMs - elapsed()) : Infinity);

  for (;;) {
    if (signal?.aborted) return { interrupted: 'aborted', sleptMs };
    const remBefore = remaining();
    if (remBefore <= 0) return { interrupted: 'timeout', sleptMs };

    const res = await raceWithDeadline(
      (callSignal) => fetchAppJob({ env, fetch, signal: callSignal }, jobId, { showId }),
      { signal, remainingMs: remBefore, now, t0, waitMs: capMs },
    );
    if (res.interrupted) return { interrupted: res.interrupted, sleptMs };
    const v = res.value;
    if (v?.aborted) return { interrupted: 'aborted', sleptMs };
    if (!v?.error || !v.retryable || !wait) return { interrupted: null, value: v, sleptMs };

    transientErrors += 1;
    const delayMs = (Number.isFinite(v.retryAfterSec) && v.retryAfterSec > 0)
      ? v.retryAfterSec * 1000
      : Math.min(pollMs * (2 ** Math.min(transientErrors - 1, 3)), Math.max(pollMs, 60_000));
    const remAfter = remaining();
    if (remAfter <= 0 || signal?.aborted) {
      return { interrupted: signal?.aborted ? 'aborted' : 'timeout', sleptMs };
    }
    const actualDelay = Math.min(delayMs, remAfter);
    const slept = await raceWithDeadline((callSignal) => sleep(actualDelay, callSignal), {
      signal, remainingMs: remAfter, now, t0, waitMs: capMs,
    });
    if (slept.interrupted) return { interrupted: slept.interrupted, sleptMs };
    sleptMs += actualDelay;
  }
}

/**
 * Resolve a saved App bookmark matching this exact github.com repo, commit, open PR (or ref), and tier
 * BEFORE calling `/api/github-app/status` or checking Actions so a transient `/status` outage never falls
 * through to dispatch Actions, while Enterprise checkouts or switched PRs at the same SHA never reuse a
 * mismatched saved job.
 */
export async function resolveMatchingAppBookmark({
  exec = realExec,
  fetch = globalThis.fetch,
  cwd,
  env,
  saved,
  tier = 'standard',
  head = null,
  wait = true,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = () => Date.now(),
  t0 = now(),
  sleep = defaultSleep,
  signal = null,
  saveLatest = null,
}) {
  if (!APP_PATH_ENABLED || !saved || saved.runner !== 'app' || !isAppId(saved.id) || saved.tier !== tier || !saved.headSha || !saved.nwo) {
    return { action: 'continue' };
  }
  if (!extractAppToken(env)) return { action: 'continue' };

  // Verify repository host and owner/name BEFORE ever touching a saved github.com App job.
  let repo = null;
  try {
    repo = await ghRepoPreflight({ exec, cwd, env, signal });
  } catch (e) {
    if (e instanceof SetupError) {
      repo = await gitRepoFallback({ exec, cwd, env, signal, ghError: e });
    } else {
      throw e;
    }
  }
  const reusablePreRepo = repo?.defaultBranch ? repo : null;
  if (!repo || !repo.isGithubCom) {
    return { action: 'continue', preRepo: reusablePreRepo };
  }
  if (saved.nwo.toLowerCase() !== repo.nwo.toLowerCase()) {
    return { action: 'continue', preRepo: reusablePreRepo };
  }

  const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal });
  const headRef = head ?? 'HEAD';
  const hs = await run('git', ['rev-parse', '--verify', `${headRef}^{commit}`]);
  const headSha = hs.stdout.trim().toLowerCase();
  const headMatchesSaved = headSha === saved.headSha;
  const headMatchesRequested = Boolean(saved.requestedHeadSha && headSha === saved.requestedHeadSha);
  if (hs.code !== 0 || !SHA_RE.test(headSha) || (!headMatchesSaved && !headMatchesRequested)) {
    return { action: 'continue', preRepo: reusablePreRepo };
  }

  // Resolve the current open PR (including its base SHA/ref and head SHA) before reusing a bookmark:
  // two PRs at the same SHA or a retargeted PR base have different diffs, and a moved PR or PR lookup
  // outage must stop rather than fall through to a narrowed single-commit review.
  let currentPr = null;
  if (repo.hasGh) {
    const prInfo = await detectOpenPr({ run, nwo: repo.nwo, headSha, env });
    if (prInfo.state === 'aborted') return { action: 'aborted' };
    if (prInfo.state === 'error') {
      return { action: 'stop', code: 4, text: `${prInfo.error}\n` };
    }
    if (prInfo.state === 'head_mismatch') {
      if (headMatchesRequested && saved.prNumber === prInfo.pr.number) {
        return {
          action: 'stop',
          code: 4,
          text: describeHeadMismatch({
            tier,
            expectedSha: headSha,
            actualSha: saved.headSha,
            nwo: repo.nwo,
            prNumber: saved.prNumber,
          }),
        };
      }
      if (head === null) {
        return {
          action: 'stop',
          code: 4,
          text: describePrHeadBehind({
            tier,
            expectedSha: headSha,
            prHeadSha: prInfo.pr.headSha,
            nwo: repo.nwo,
            prNumber: prInfo.pr.number,
          }),
        };
      }
      return { action: 'continue', preRepo: reusablePreRepo };
    }
    if (prInfo.state === 'open') currentPr = prInfo.pr;
  }

  if (headMatchesRequested) {
    if (!repo.hasGh && saved.prNumber === null) {
      return {
        action: 'stop',
        code: 4,
        text: describeHeadMismatch({
          tier,
          expectedSha: headSha,
          actualSha: saved.headSha,
          nwo: repo.nwo,
          prNumber: null,
        }),
      };
    }
    return { action: 'continue', preRepo: reusablePreRepo };
  }

  const currentPrNumber = currentPr?.number ?? null;
  if ((saved.prNumber ?? null) !== currentPrNumber) {
    return { action: 'continue', preRepo: reusablePreRepo };
  }
  if (currentPr && !bookmarkMatchesPrBase(saved, currentPr)) {
    return { action: 'continue', preRepo: reusablePreRepo };
  }

  let dirty;
  try {
    dirty = await worktreeDirty(run);
  } catch (e) {
    if (e instanceof SetupError) return { action: 'stop', code: 4, text: `${e.message}\n` };
    throw e;
  }
  if (dirty && head === null) {
    return { action: 'stop', code: 4, text: `${MSG.dirtyStop}\n` };
  }
  const note = dirty ? `${MSG.uncommitted}\n` : '';

  const read = await fetchAppJobWithRetry({
    env,
    fetch,
    jobId: appJobIdOf(saved.id),
    showId: false,
    wait,
    waitMs,
    pollMs: pollMs ?? DEFAULT_POLL_MS,
    now,
    t0,
    sleep,
    signal,
  });
  if (read.interrupted === 'aborted') return { action: 'aborted' };
  if (read.interrupted === 'timeout') return { action: 'timed_out' };
  const v = read.value;
  if (v.error) {
    if (v.notFound) return { action: 'continue', preRepo: reusablePreRepo };
    // Non-404 error (401 or retryable error with --no-wait) while a matching App job exists: stop instead of dispatching Actions.
    return { action: 'stop', code: 4, text: v.error };
  }
  const job = v.job;
  if (!jobMatchesTargetPr(job, repo.nwo, currentPrNumber)) {
    return { action: 'continue', preRepo: reusablePreRepo };
  }
  const actualSha = normalizedJobHeadSha(job);
  if (actualSha && actualSha !== headSha) {
    saveLatest?.({
      id: saved.id,
      runner: 'app',
      nwo: repo.nwo,
      tier,
      headSha: actualSha,
      requestedHeadSha: headSha,
      prNumber: currentPrNumber,
      prBaseSha: currentPr?.baseSha ?? saved.prBaseSha ?? null,
      prBaseRef: currentPr?.baseRef ?? saved.prBaseRef ?? null,
    });
    return {
      action: 'stop',
      code: 4,
      text: `${note}${describeHeadMismatch({ tier, expectedSha: headSha, actualSha, nwo: repo.nwo, prNumber: currentPrNumber })}`,
    };
  }
  const st = String(job.status ?? '');
  if (st === 'queued' || st === 'running') {
    return {
      action: 'resume',
      resumeAttempt: {
        id: saved.id,
        job,
        headSha,
        nwo: repo.nwo,
        prNumber: currentPrNumber,
        prBaseSha: currentPr?.baseSha ?? saved.prBaseSha ?? null,
        prBaseRef: currentPr?.baseRef ?? saved.prBaseRef ?? null,
        note,
        initialSleptMs: read.sleptMs,
      },
    };
  }
  if (st === 'done' && job.findings && ['complete', 'partial', 'too_large'].includes(String(job.result_status ?? ''))) {
    const rendered = renderAppJob(job, saved.id, { env, showId: false });
    return { action: 'rendered', code: rendered.code, text: `${note}${rendered.text}`, id: saved.id };
  }
  return { action: 'continue', preRepo: reusablePreRepo };
}

/**
 * /megalens:review through the MegaLens GitHub App on-demand API:
 * Preflights repo/token/commit, reuses an existing in-flight or retained job for the same commit, PR & tier when present,
 * otherwise verifies the bookmark can be written, submits via POST /api/github-app/review-now, bookmarks it,
 * waits up to 20 minutes with short progress lines (continuing across retryable poll errors with Retry-After backoff),
 * verifies the returned job's head_sha matches the local checkout, and prints findings inline in the same answer.
 */
export async function appReview({
  exec = realExec,
  fetch = globalThis.fetch,
  cwd,
  env,
  tier = 'standard',
  base = null,
  head = null,
  wait = true,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  progressMs = DEFAULT_PROGRESS_MS,
  now = () => Date.now(),
  t0 = now(),
  sleep = defaultSleep,
  signal = null,
  onLine = null,
  saveLatest = null,
  loadLatest = null,
  canSaveLatest = null,
  preRepo = null,
  resumeAttempt = null,
}) {
  if (tier !== 'standard' && tier !== 'deep') return { text: 'The MegaLens GitHub App runs the standard or deep tier.\n', code: 4 };
  if (base !== null) return { text: `${MSG.appRangeUnsupported}\n`, code: 4 };
  const capMs = wait ? waitMs : Infinity;
  const remaining = () => (Number.isFinite(capMs) ? Math.max(0, capMs - Math.max(0, now() - t0)) : Infinity);
  const bounded = (fn) => raceWithDeadline(fn, { signal, remainingMs: remaining(), now, t0, waitMs: capMs });
  let acc = '';
  const emit = (s) => { acc += s; onLine?.(s); };

  let id = null;
  let reused = false;
  let bookmarkSaved = true;
  let targetMeta = null;
  let initialSleptMs = 0;

  if (resumeAttempt && isAppId(resumeAttempt.id)) {
    id = resumeAttempt.id;
    reused = true;
    initialSleptMs = Math.max(0, Number(resumeAttempt.initialSleptMs) || 0);
    targetMeta = {
      nwo: resumeAttempt.nwo ?? null,
      headSha: resumeAttempt.headSha,
      prNumber: resumeAttempt.prNumber ?? null,
      prBaseSha: resumeAttempt.prBaseSha ?? null,
      prBaseRef: resumeAttempt.prBaseRef ?? null,
    };
    if (resumeAttempt.note) emit(resumeAttempt.note);
  } else {
    let pre;
    try {
      const preRes = await bounded((callSignal) => appPreflight({ exec, cwd, env, tier, preRepo, base, head, signal: callSignal }));
      if (preRes.interrupted === 'aborted') {
        return { text: 'Interrupted before starting the review. Nothing was started and no credit was used.\n', code: 4, aborted: true };
      }
      if (preRes.interrupted === 'timeout') {
        return { text: 'Timed out before starting the review. Nothing was started and no credit was used.\n', code: 4, timedOut: true };
      }
      pre = preRes.value;
    } catch (e) {
      if (e instanceof SetupError) return { text: e.message.endsWith('\n') ? e.message : `${e.message}\n`, code: 4, setup: true, needsUser: e.needsUser };
      throw e;
    }

    targetMeta = {
      nwo: pre.nwo,
      headSha: pre.headSha,
      prNumber: pre.prNumber,
      prBaseSha: pre.prBaseSha ?? null,
      prBaseRef: pre.prBaseRef ?? null,
    };
    if (pre.note) emit(pre.note);

    // Layer 1 dedupe: if we already bookmarked an App job for this exact repo + commit + PR + PR base + tier, check it first
    // so re-running /megalens:review after a timeout or lost reply reuses the in-flight or retained job with no POST.
    const prev = loadLatest?.();
    const currentPrTarget = pre.prNumber !== null ? { baseSha: pre.prBaseSha, baseRef: pre.prBaseRef } : null;
    if (
      prev
      && prev.runner === 'app'
      && isAppId(prev.id)
      && prev.nwo
      && prev.nwo.toLowerCase() === pre.nwo.toLowerCase()
      && prev.tier === tier
      && prev.headSha === pre.headSha
      && (prev.prNumber ?? null) === (pre.prNumber ?? null)
      && bookmarkMatchesPrBase(prev, currentPrTarget)
    ) {
      const existing = await fetchAppJobWithRetry({
        env,
        fetch,
        jobId: appJobIdOf(prev.id),
        showId: false,
        wait,
        waitMs: capMs,
        pollMs,
        now,
        t0,
        sleep,
        signal,
      });
      initialSleptMs = existing.sleptMs;
      if (existing.interrupted) {
        emit(`${STILL_RUNNING_LINE}\n`);
        return { text: acc, code: 0, id: prev.id, timedOut: existing.interrupted === 'timeout', aborted: existing.interrupted === 'aborted' };
      }
      if (existing.value?.error && !existing.value.notFound) {
        emit(existing.value.error);
        return { text: acc, code: 4, id: prev.id };
      }
      const job = existing.value?.job;
      if (job && jobMatchesTargetPr(job, pre.nwo, pre.prNumber)) {
        const actualSha = normalizedJobHeadSha(job);
        if (actualSha && actualSha !== pre.headSha) {
          saveLatest?.({
            id: prev.id,
            runner: 'app',
            nwo: pre.nwo,
            tier,
            headSha: actualSha,
            requestedHeadSha: pre.headSha,
            prNumber: pre.prNumber,
            prBaseSha: pre.prBaseSha,
            prBaseRef: pre.prBaseRef,
          });
          emit(describeHeadMismatch({ tier, expectedSha: pre.headSha, actualSha, nwo: pre.nwo, prNumber: pre.prNumber }));
          return { text: acc, code: 4, id: prev.id, reused: true };
        }
        const st = String(job.status ?? '');
        if (st === 'queued' || st === 'running') {
          id = prev.id;
          reused = true;
        } else if (st === 'done' && job.findings && ['complete', 'partial', 'too_large'].includes(String(job.result_status ?? ''))) {
          const rendered = renderAppJob(job, prev.id, { env, showId: false });
          emit(rendered.text);
          return { text: acc, code: rendered.code, id: prev.id, reused: true };
        }
      }
    }

    if (!id) {
      if (canSaveLatest && !canSaveLatest()) {
        return { text: `${MSG.appBookmarkUnwritable}\n`, code: 4, setup: true };
      }
      const started = await startAppReview({ pre, tier, env, fetch, sleep, now, t0, waitMs: capMs, signal, exec, cwd });
      if (!started.ok) {
        emit(started.text);
        return {
          text: acc,
          code: 4,
          aborted: Boolean(started.aborted),
          timedOut: Boolean(started.timedOut),
          needsUser: Boolean(started.needsUser),
        };
      }
      id = started.id;
      if (saveLatest) {
        bookmarkSaved = saveLatest({
          id,
          runner: 'app',
          nwo: pre.nwo,
          tier,
          headSha: pre.headSha,
          prNumber: pre.prNumber,
          prBaseSha: pre.prBaseSha,
          prBaseRef: pre.prBaseRef,
        }) !== false;
      }
    }
  }

  const stillRunningLine = bookmarkSaved
    ? STILL_RUNNING_LINE
    : `Still running. Could not save the local bookmark; run /megalens:result ${id} to see it.`;

  if (!wait) {
    emit(`${reused ? 'Review already in progress' : 'Review started'}\n${stillRunningLine}\n`);
    return { text: acc, code: 0, id, reused };
  }

  const baseCtx = { env, fetch };
  let transientErrors = 0;
  const w = await waitForReview({
    poll: async (callSignal) => {
      const ctx = { ...baseCtx, signal: callSignal };
      const st = await appStatus(ctx, id, { showId: false });
      if (st.state === 'aborted' || callSignal.aborted) return { state: 'aborted' };
      if (st.state === 'error') {
        if (st.retryable) {
          transientErrors += 1;
          const retryAfterMs = (Number.isFinite(st.retryAfterSec) && st.retryAfterSec > 0)
            ? st.retryAfterSec * 1000
            : Math.min(pollMs * (2 ** Math.min(transientErrors - 1, 3)), Math.max(pollMs, 60_000));
          return { state: 'retry', retryAfterMs };
        }
        return st;
      }
      transientErrors = 0;
      const actualSha = normalizedJobHeadSha(st.job);
      if (actualSha && targetMeta?.headSha && actualSha !== targetMeta.headSha) {
        return { state: 'error', headMismatch: true, actualSha, job: st.job };
      }
      return st;
    },
    onLine: emit,
    startedLine: reused ? 'Resuming in-flight review' : 'Review started',
    queuedLine: 'Waiting for MegaLens review machine...',
    runningLine: 'Running on MegaLens...',
    stillRunningLine,
    waitMs,
    pollMs,
    progressMs,
    now,
    t0,
    initialSleptMs,
    sleep,
    signal,
  });

  if (w.finished && w.last?.headMismatch) {
    if (saveLatest && targetMeta) {
      saveLatest({
        id,
        runner: 'app',
        nwo: targetMeta.nwo,
        tier,
        headSha: w.last.actualSha,
        requestedHeadSha: targetMeta.headSha,
        prNumber: targetMeta.prNumber,
        prBaseSha: targetMeta.prBaseSha,
        prBaseRef: targetMeta.prBaseRef,
      });
    }
    emit(describeHeadMismatch({
      tier,
      expectedSha: targetMeta.headSha,
      actualSha: w.last.actualSha,
      nwo: targetMeta.nwo,
      prNumber: targetMeta.prNumber,
    }));
    return { text: acc, code: 4, id, reused };
  }
  if (w.finished && w.last?.job) {
    const rendered = renderAppJob(w.last.job, id, { env, showId: false });
    emit(rendered.text);
    return { text: acc, code: rendered.code, id, reused };
  }
  if (w.finished && w.last?.state === 'error') {
    const fallbackErr = bookmarkSaved
      ? 'Could not read the MegaLens review.\n'
      : `Could not read the MegaLens review. Try /megalens:result ${id} to recover it.\n`;
    const msg = w.last.text
      ? (bookmarkSaved ? w.last.text : `${w.last.text.trimEnd()} Try /megalens:result ${id} to recover it.\n`)
      : fallbackErr;
    emit(msg);
    return { text: acc, code: 4, id, reused };
  }
  return { text: acc, code: 0, id, reused, timedOut: w.timedOut, aborted: w.aborted };
}

/** Find the latest workflow review of the checked-out commit for no-id status and result. */
export async function findLatestRemoteReview({ exec, cwd, env, signal = null }) {
  const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env), signal });
  const head = await run('git', ['rev-parse', '--verify', 'HEAD^{commit}']);
  const headSha = head.stdout.trim();
  if (head.code !== 0 || !SHA_RE.test(headSha) || signal?.aborted) return null;

  const nwo = await repoOf({ exec, cwd, env, signal });
  if (!nwo || signal?.aborted) return null;
  const rows = await listRuns(run, nwo, 5);
  if (!rows) return null;
  const [latest] = rows.filter((row) => workflowRange(row.displayTitle)?.head === headSha)
    .sort((a, b) => (parseTs(b.createdAt) - parseTs(a.createdAt)) || (b.databaseId - a.databaseId));
  if (!latest) return null;
  return { id: `gh:${latest.databaseId}`, runner: 'github', nwo, startedAt: parseTs(latest.createdAt) };
}
