// Review through the user's own GitHub Actions runner: `gh` front end. No new dependencies.
// Every `gh` / `git` call goes through an injectable `exec(cmd, args, {cwd, env})` -> {code, stdout, stderr}, so tests use a fake.
// This file never reads, prints or passes MEGALENS_TOKEN or any secret value. It only asks `gh secret list` for the NAME.
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveStatus, renderResult, scrub } from './engine-core.mjs';

export const WORKFLOW_FILE = 'megalens-dispatch.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
export const WORKFLOW_NAME = 'MegaLens Dispatch';
export const ARTIFACT_NAME = 'megalens-findings';
const RETRY_ARTIFACT_NAME = 'megalens-findings-retry';
export const SECRET_NAME = 'MEGALENS_TOKEN';
export const ACTION_GATEWAY_NOTICE = 'The diff and code excerpts pass through the MegaLens gateway to OpenAI. MegaLens does not keep your code; it passes through our gateway to the AI provider for the review and is not stored.';
export const ACTION_TOKEN_SETUP = `Run \`npx megalens-review init\` in your repository and sign in through your browser. It passes the token to \`gh\` on stdin to set the \`${SECRET_NAME}\` repository secret without asking you to paste it. Decline the separate pull request for automatic PR reviews. If browser setup is unavailable, create an Action token at https://megalens.ai/app/settings/mcp and enter it at the private terminal prompt from \`gh secret set ${SECRET_NAME}\`.`;
export const RUN_ID_RE = /^gh:([1-9][0-9]{0,17})$/;
const MAX_FINDINGS = 1 << 22;

export const templatePath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', WORKFLOW_FILE);
export const workflowText = () => readFileSync(templatePath(), 'utf8');

export class SetupError extends Error { constructor(msg, { needsUser = false } = {}) { super(msg); this.needsUser = needsUser; } }

/** Remove the exact secret values from text. The pattern scrub is applied to model-written text only: a repo called ml-something must not be redacted out of its own URL. */
export function scrubExact(text, env = {}) {
  let t = String(text ?? '');
  for (const k of ['MEGALENS_TOKEN', 'OPENAI_API_KEY', 'MEGALENS_REVIEW_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) { const v = env[k]; if (typeof v === 'string' && v.length >= 6) t = t.split(v).join('[redacted]'); }
  // GitHub token shapes cannot be a repo name that matters here, so they are safe to cut by pattern.
  return t.replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, '[redacted]').replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]');
}

export const isRunnerId = (s) => typeof s === 'string' && RUN_ID_RE.test(s);
export const runIdOf = (s) => { const m = RUN_ID_RE.exec(String(s ?? '')); if (!m) throw new SetupError('that is not a GitHub review id (they look like gh:123456789)'); return m[1]; };

/**
 * Which route runs the review?
 *   --runner github -> github; --runner local -> local;
 *   not Linux -> github; Linux -> local first, with a fall back to github when the engine is missing or fails its sandbox pre-check.
 * Returns {route, fallbackAllowed}.
 */
export function chooseRoute({ platform = process.platform, runner = null } = {}) {
  if (runner === 'github') return { route: 'github', fallbackAllowed: false };
  if (runner === 'local') return { route: 'local', fallbackAllowed: false };
  if (platform !== 'linux') return { route: 'github', fallbackAllowed: false };
  return { route: 'local', fallbackAllowed: true };
}

/** True when the local engine result means "use the runner instead": binary missing, or the sandbox pre-check failed (exit 4). */
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

/** Real exec: spawn without a shell, capped output. Missing binary -> code 127. */
export function realExec(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env: ghEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return resolve({ code: 127, stdout: '', stderr: String(e.message) }); }
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { if (stdout.length < MAX_FINDINGS) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_FINDINGS) stderr += c; });
    child.on('error', (e) => resolve({ code: e.code === 'ENOENT' ? 127 : 4, stdout, stderr: String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 4, stdout, stderr }));
  });
}

const firstLine = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';
const short = (sha) => String(sha).slice(0, 7);
const jsonOf = (s) => { try { return JSON.parse(s); } catch { return null; } };
const SHA_RE = /^[0-9a-f]{40}$/;

export const MSG = {
  noGh: 'GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com, then run `gh auth login`, then run this again.',
  noLogin: 'GitHub CLI (`gh`) is not logged in. Run `gh auth login`, then run this again.',
  noRemote: 'This folder has no GitHub remote, so the review cannot run on your GitHub runner. Create or connect the repository: `gh repo create` (new) or `git remote add origin https://github.com/OWNER/REPO.git` (existing), push, then run this again.',
  noSecret: `The repository secret ${SECRET_NAME} is missing. ${ACTION_TOKEN_SETUP} Then run this again.`,
  secretUnknown: `Could not check the repository secret ${SECRET_NAME} (no permission to list secrets). Going on; if it is missing the run fails at its first job and no review is charged.`,
  uncommitted: 'Note: uncommitted changes are not reviewable on the GitHub runner path. Only commits that are on GitHub are reviewed. Commit and push them first if you want them reviewed.',
  dirtyStop: 'You have uncommitted changes, and the GitHub runner can only review commits that are on GitHub, so it would review a different change than the one you are editing. Nothing was started and no credit was used. Commit and push your changes, then run this again. (On Linux with the local engine, `--runner local` reviews uncommitted changes. To review only the commits already on GitHub, name the range: `--base <ref> --head HEAD`.)',
  secretCheckFailed: (why) => `Could not check the repository secret ${SECRET_NAME}: ${why || 'gh gave no reason'}. Nothing was started. Check your network and \`gh auth status\`, then run this again.`,
  orgSecretUnknown: `${SECRET_NAME} is not a repository secret, and the organisation secrets could not be read. Going on; if it is missing the run fails at its first job and no review is charged.`,
  notFound: (url) => `The workflow was started, but its run could not be found, so there is no id to give you. A review may have been started and charged: do NOT start another one. Open ${url} to find the run, then use its number as gh:<number> with /megalens:status and /megalens:result. Nothing has been reviewed yet.`,
};

export function workflowMissingMessage(branch) {
  return `The MegaLens workflow is not on your default branch (${branch}). Add this file as ${WORKFLOW_PATH} on ${branch}, commit it and push it, then run this again. GitHub only starts it from the default branch.\n\n--- ${WORKFLOW_PATH} ---\n${workflowText()}--- end of file ---\n`;
}

export function notPushedMessage(sha, branch) {
  return `NEEDS THE USER'S OK: your latest commit (${short(sha)}) is not on GitHub yet, and the runner can only review what is on GitHub. Nothing was pushed. Ask the user: "Push ${branch || 'this branch'} to GitHub so it can be reviewed?" Only if the user says yes, run \`git push\` (if the branch has no upstream: \`git push -u origin HEAD\`), then run /megalens:review again. If the user says no, stop.\n`;
}

/** Check secret names only. GitHub can return 404 when the caller lacks access to an organization's secrets. */
export async function actionSecretStatus(run, nwo, isInOrganization) {
  const sl = await run('gh', ['secret', 'list', '--json', 'name', '-R', nwo]);
  const names = sl.code === 0 ? jsonOf(sl.stdout) : null;
  if (!Array.isArray(names)) {
    const noPermission = /HTTP 403|HTTP 404|Resource not accessible|not accessible by integration|must have admin/i;
    if (noPermission.test(sl.stderr)) return { present: 'unknown', note: MSG.secretUnknown };
    return { present: 'unknown', error: firstLine(sl.stderr) };
  }
  if (names.some((s) => s?.name === SECRET_NAME)) return { present: true };
  if (isInOrganization === false) return { present: false };

  // gh secret list shows repository secrets only. An organization secret shared with this repository also works.
  const og = await run('gh', ['api', '-X', 'GET', `repos/${nwo}/actions/organization-secrets`, '-f', 'per_page=100', '--paginate', '--jq', '[.secrets[].name]']);
  if (og.code === 0) {
    const pages = og.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map(jsonOf);
    if (pages.length && pages.every(Array.isArray)) return { present: pages.some((page) => page.includes(SECRET_NAME)) };
  }
  return { present: 'unknown', note: MSG.orgSecretUnknown };
}

/** Everything the review needs to know before it starts. Throws SetupError with a message naming the exact fix. */
export async function preflight({ exec, cwd, env, base = null, head = null, requireClean = base === null && head === null }) {
  const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env) });
  const v = await run('gh', ['--version']);
  if (v.code === 127) throw new SetupError(MSG.noGh);
  // --active: a stale second account must not make a working login look broken. Older gh has no such flag, so retry plain.
  let au = await run('gh', ['auth', 'status', '--active']);
  if (au.code !== 0 && /unknown flag/i.test(au.stderr)) au = await run('gh', ['auth', 'status']);
  if (au.code !== 0) throw new SetupError(MSG.noLogin);
  const rv = await run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url,isInOrganization']);
  const repo = rv.code === 0 ? jsonOf(rv.stdout) : null;
  if (!repo || typeof repo.nameWithOwner !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.nameWithOwner) || typeof repo.defaultBranchRef?.name !== 'string') throw new SetupError(MSG.noRemote);
  const nwo = repo.nameWithOwner; const defaultBranch = repo.defaultBranchRef.name;
  if (!/^[\w./-]{1,100}$/.test(defaultBranch)) throw new SetupError(MSG.noRemote);

  const workflowFields = '[.type, (.content // "" | gsub("[\\r\\n]"; ""))] | @tsv';
  const wf = await run('gh', ['api', '-X', 'GET', `repos/${nwo}/contents/${WORKFLOW_PATH}`, '-f', `ref=${defaultBranch}`, '--jq', workflowFields]);
  const [workflowType, encodedWorkflow = ''] = wf.stdout.trimEnd().split('\t');
  if (wf.code !== 0 || workflowType !== 'file') throw new SetupError(workflowMissingMessage(defaultBranch));
  // Older installed templates do not accept the approval input.
  const workflow = Buffer.from(encodedWorkflow, 'base64').toString('utf8');
  const hasGatewayInput = /^ {6}allow_gateway:[ \t]*(?:#.*)?\r?$/m.test(workflow);

  const secret = await actionSecretStatus(run, nwo, repo.isInOrganization);
  if (secret.present === false) throw new SetupError(MSG.noSecret);
  if (secret.error !== undefined) throw new SetupError(MSG.secretCheckFailed(scrub(secret.error, env)));
  let note = secret.note ? `${secret.note}\n` : '';

  // The change: HEAD against the merge-base with the default branch (or the range the user named).
  const headRef = head ?? 'HEAD';
  const hs = await run('git', ['rev-parse', '--verify', `${headRef}^{commit}`]);
  const headSha = hs.stdout.trim();
  if (hs.code !== 0 || !SHA_RE.test(headSha)) throw new SetupError('Could not read the commit to review (is this a git repository with a commit?).');
  let baseSha = '';
  for (const b of base ? [base] : [`origin/${defaultBranch}`, defaultBranch]) {
    const mb = await run('git', ['merge-base', headSha, b]);
    if (mb.code === 0 && SHA_RE.test(mb.stdout.trim())) { baseSha = mb.stdout.trim(); break; }
  }
  if (!baseSha) {
    const message = base
      ? 'Could not find a merge base for the requested comparison. Fetch the comparison branch and try again.'
      : `Could not find where this work branches off ${defaultBranch}. Run \`git fetch origin ${defaultBranch}\` and try again.`;
    throw new SetupError(message);
  }
  if (baseSha === headSha) {
    const comparison = base ? 'the comparison base' : `the default branch (${defaultBranch})`;
    throw new SetupError(`Nothing to review: ${short(headSha)} is the same commit as ${comparison}, so there is no change between them. Commit your work on a branch first.`);
  }

  const dirty = await run('git', ['status', '--porcelain']);
  if (requireClean && dirty.code !== 0) throw new SetupError('Could not verify that the checkout is clean. Nothing was started and no credit was used. Check `git status` and try again.');
  if (dirty.code === 0 && dirty.stdout.trim()) {
    // A range inferred by the caller still means the change the user is editing.
    if (requireClean) throw new SetupError(MSG.dirtyStop);
    note += `${MSG.uncommitted}\n`;
  }

  const onGh = await run('gh', ['api', `repos/${nwo}/commits/${headSha}`, '--jq', '.sha']);
  if (onGh.code !== 0 || onGh.stdout.trim() !== headSha) {
    const br = await run('git', ['branch', '--show-current']);
    const bn = br.stdout.trim();
    throw new SetupError(notPushedMessage(headSha, /^[\w./-]{1,100}$/.test(bn) ? bn : ''), { needsUser: true });
  }
  return { nwo, defaultBranch, baseSha, headSha, note, hasGatewayInput };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const runTitle = (tier, baseSha, headSha) => `MegaLens ${tier} ${baseSha}..${headSha}`;
const listRuns = async (run, nwo) => {
  const l = await run('gh', ['run', 'list', '--workflow', WORKFLOW_FILE, '--event', 'workflow_dispatch', '--limit', '50', '--json', 'databaseId,displayTitle,createdAt,url', '-R', nwo]);
  const rows = l.code === 0 ? jsonOf(l.stdout) : null;
  return Array.isArray(rows) ? rows.filter((x) => x && Number.isInteger(x.databaseId)) : null;
};

/**
 * Start the run and find the id it created. Run ids that exist before the dispatch are recorded; only a NEW run
 * whose title is exactly "MegaLens <tier> <base>..<head>" counts. If the match is not certain (none found, or more than
 * one new run with that title) nothing is started again: the caller reports "could not find the run".
 */
export async function startRun({ exec, cwd, env, tier, pre, allowGateway, sleepMs = 2000, tries = 15 }) {
  if (pre.hasGatewayInput && allowGateway !== true) {
    throw new SetupError(`${ACTION_GATEWAY_NOTICE} Nothing was started. To approve this transfer for this review, run it again with --allow-gateway.`);
  }
  const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env) });
  const before = await listRuns(run, pre.nwo);
  if (before === null) throw new SetupError('Could not list the existing workflow runs, so a new run could not be told apart. Nothing was started and no credit was used. Check `gh auth status` and your network, then run this again.');
  const seen = new Set(before.map((x) => x.databaseId));
  const title = runTitle(tier, pre.baseSha, pre.headSha);
  const args = ['workflow', 'run', WORKFLOW_FILE, '--ref', pre.defaultBranch, '-f', `tier=${tier}`, '-f', `base_sha=${pre.baseSha}`, '-f', `head_sha=${pre.headSha}`, '-R', pre.nwo];
  if (pre.hasGatewayInput) args.push('-f', 'allow_gateway=true');
  const r = await run('gh', args);
  if (r.code !== 0) throw new SetupError(`GitHub did not start the workflow: ${scrub(firstLine(r.stderr), env) || 'no reason given'}. Check that ${WORKFLOW_PATH} is on ${pre.defaultBranch} and that you can run workflows in this repository.`);
  for (let i = 0; i < tries; i++) {
    const rows = await listRuns(run, pre.nwo);
    if (rows) {
      const hits = rows.filter((x) => !seen.has(x.databaseId) && x.displayTitle === title);
      if (hits.length === 1) { const hit = hits[0]; return { id: `gh:${hit.databaseId}`, url: typeof hit.url === 'string' ? hit.url : `https://github.com/${pre.nwo}/actions/runs/${hit.databaseId}` }; }
      if (hits.length > 1) break; // two new runs with the same title: not certain which is ours
    }
    await sleep(sleepMs);
  }
  return { id: null, url: `https://github.com/${pre.nwo}/actions/workflows/${WORKFLOW_FILE}` };
}

/** gh run state -> queued / running / done / failed. */
export function mapState(status, conclusion) {
  const s = String(status ?? ''); const c = String(conclusion ?? '');
  if (s === 'completed') return c === 'success' ? 'done' : 'failed';
  if (['in_progress'].includes(s)) return 'running';
  if (['queued', 'waiting', 'pending', 'requested'].includes(s)) return 'queued';
  return 'failed'; // anything unknown is never reported as fine
}

/** The repository gh works in, resolved once; every later call names it with -R. Null when gh cannot tell (the call then runs without -R). */
async function repoOf({ exec, cwd, env }) {
  const rv = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd, env: ghEnv(env) });
  const j = rv.code === 0 ? jsonOf(rv.stdout) : null;
  return typeof j?.nameWithOwner === 'string' && /^[\w.-]+\/[\w.-]+$/.test(j.nameWithOwner) ? j.nameWithOwner : null;
}
const scoped = (args, nwo) => (nwo ? [...args, '-R', nwo] : args);

async function viewRun({ exec, cwd, env }, id, nwo = null) {
  const r = await exec('gh', scoped(['run', 'view', id, '--json', 'status,conclusion,url,workflowName,displayTitle,attempt'], nwo), { cwd, env: ghEnv(env) });
  const j = r.code === 0 ? jsonOf(r.stdout) : null;
  if (!j || typeof j.status !== 'string') return { error: `Could not read run gh:${id}: ${scrub(firstLine(r.stderr), env) || 'no usable answer from gh'}. Check the id, that you are in the same repository, and \`gh auth status\`. This is not a finished review.\n` };
  if (j.workflowName !== WORKFLOW_NAME) return { error: `gh:${id} is not a MegaLens review run. Nothing was read from it.\n` };
  return { j };
}

export async function runnerStatus(ctx, rawId) {
  const id = runIdOf(rawId);
  const v = await viewRun(ctx, id, await repoOf(ctx)); if (v.error) return { text: v.error, code: 4 };
  const state = mapState(v.j.status, v.j.conclusion); const url = String(v.j.url ?? '').slice(0, 300);
  const words = {
    queued: 'Queued: GitHub has not started it yet. Check again in a minute.',
    running: `Running. Check again with /megalens:status gh:${id}.`,
    done: `Done. Fetch it with /megalens:result gh:${id}.`,
    failed: `FAILED: the run did not finish successfully (${scrub(String(v.j.conclusion ?? v.j.status), ctx.env).slice(0, 40)}). It is not a clean review and says nothing about your change. /megalens:result gh:${id} shows what was recorded, if anything.`,
  }[state];
  return { text: `Review gh:${id}: ${state}. ${words}\nRun: ${url}\n`, code: 0, state, attempt: v.j.attempt };
}

export async function runnerResult(ctx, rawId) {
  const id = runIdOf(rawId);
  const nwo = await repoOf(ctx);
  const v = await viewRun(ctx, id, nwo); if (v.error) return { text: v.error, code: 4 };
  const state = mapState(v.j.status, v.j.conclusion);
  if (state === 'queued' || state === 'running') return { text: `That review is still ${state === 'queued' ? 'queued' : 'running'}, so there is no result yet. Nothing has been found or ruled out. Check with /megalens:status gh:${id}.\n`, code: 4 };
  const dir = mkdtempSync(path.join(tmpdir(), 'megalens-'), { mode: 0o700 });
  try {
    let doc = null;
    let stderrText = '';
    for (const artifact of [ARTIFACT_NAME, RETRY_ARTIFACT_NAME]) {
      const dest = path.join(dir, artifact);
      mkdirSync(dest);
      const result = await ctx.exec('gh', scoped(['run', 'download', id, '-n', artifact, '-D', dest], nwo), { cwd: ctx.cwd, env: ghEnv(ctx.env) });
      stderrText ||= firstLine(result.stderr);
      if (result.code !== 0) continue;
      const file = path.join(dest, 'findings.json');
      try {
        const artifactFile = lstatSync(file);
        if (!artifactFile.isFile() || artifactFile.size > MAX_FINDINGS) continue;
        const candidate = JSON.parse(readFileSync(file, 'utf8'));
        if (candidate?.schema === 'megalens.findings/v1' && Array.isArray(candidate.findings)) {
          doc = candidate;
          break;
        }
      } catch { /* The other artifact may still be readable. */ }
    }
    // A run that did not succeed is never rendered as complete: exit 4 downgrades the document to FAILED.
    const text = scrub(renderResult(doc, { exit: state === 'done' ? 0 : 4, stderrText: doc ? '' : stderrText || 'no readable MegaLens findings artifact on that run' }), ctx.env);
    // Same rule as the local path: the exit code follows the validated, effective status, not the raw field.
    const passes = Array.isArray(doc?.passes) ? doc.passes : [];
    const ok = state === 'done' && doc !== null && effectiveStatus(doc, passes, passes.filter((p) => p && p.status === 'failed'), 0) !== 'failed';
    return { text: `${text}Run: ${String(v.j.url ?? '').slice(0, 300)}\n`, code: ok ? 0 : 4, doc, attempt: v.j.attempt };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** /megalens:review on the runner path: checks, start, print the id. `wait` polls (up to waitMs) and then renders the result. */
export async function runnerReview({ exec = realExec, cwd, env, tier, base = null, head = null, requireClean, allowGateway, wait = false, waitMs = 8 * 60_000, pollMs = 15_000, sleepMs, tries }) {
  if (tier !== 'standard' && tier !== 'deep') return { text: 'The GitHub runner path runs the standard or deep tier.\n', code: 4 };
  let pre;
  try { pre = await preflight({ exec, cwd, env, base, head, requireClean }); } catch (e) { if (e instanceof SetupError) return { text: e.message.endsWith('\n') ? e.message : `${e.message}\n`, code: 4, setup: true, needsUser: e.needsUser }; throw e; }
  let started;
  try { started = await startRun({ exec, cwd, env, tier, pre, allowGateway, sleepMs, tries }); } catch (e) { if (e instanceof SetupError) return { text: `${e.message}\n`, code: 4, setup: true }; throw e; }
  const intro = `${pre.note}Review of ${short(pre.baseSha)}..${short(pre.headSha)} in ${pre.nwo}, tier ${tier}, runs on your GitHub runner.\n`;
  if (!started.id) return { text: `${intro}${MSG.notFound(started.url)}\n`, code: 4 };
  const how = `Check with /megalens:status ${started.id}, then fetch with /megalens:result ${started.id}.`;
  if (!wait || tier === 'deep') {
    return { text: `${intro}Review started on GitHub: ${started.id}\nRun: ${started.url}\n${tier === 'deep' ? 'A deep review can take about 20 minutes. ' : 'A standard review usually takes a few minutes. '}${how} Nothing has been reviewed yet.\n`, code: 0, id: started.id };
  }
  const ctx = { exec, cwd, env };
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < waitMs) {
    last = await runnerStatus(ctx, started.id);
    if (last.code !== 0 || last.state === 'done' || last.state === 'failed') break;
    await sleep(pollMs);
  }
  if (last && (last.state === 'done' || last.state === 'failed')) { const r = await runnerResult(ctx, started.id); return { text: `${intro}${r.text}`, code: r.code, id: started.id }; }
  return { text: `${intro}Review started on GitHub: ${started.id}\nRun: ${started.url}\nIt is not finished yet. ${how} Nothing has been reviewed yet.\n`, code: 0, id: started.id };
}
