// MegaLens Cursor plugin command logic (GitHub Actions runner path, cross-platform Windows/macOS/Linux).
// Reuses the Claude Code plugin's gh-runner.mjs and engine-core.mjs directly.
// Supports:
//   - Review current branch or PR (standard | deep)
//   - Show the latest review result (or a specific gh:<id>), plus status
//   - Build (and optionally copy to clipboard) a clean, scrubbed fix prompt for any finding
//   - Sign-in & GitHub Actions runner readiness status
// Never prints secrets. Never calls PARTIAL/FAILED/NOT COMPLETED reviews clean.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, lstatSync, chmodSync, openSync, writeSync, fchmodSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ACTION_GATEWAY_NOTICE,
  ACTION_TOKEN_SETUP,
  SECRET_NAME,
  WORKFLOW_FILE,
  WORKFLOW_PATH,
  actionSecretStatus,
  ghEnv,
  isRunnerId,
  realExec,
  runnerResult,
  runnerReview,
  runnerStatus,
  scrubExact,
} from './gh-runner.mjs';
import {
  DOUBLE_OFF_MESSAGE,
  REF_RE,
  effectiveStatus,
  scrub,
} from './engine-core.mjs';
import { createOsSecretStore, getAuthStatus } from './browser-auth.mjs';

export const PR_NUMBER_RE = /^[1-9][0-9]{0,9}$/;
export const FINDING_INDEX_RE = /^[1-9][0-9]{0,3}$/;
export const FINDING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export { ACTION_GATEWAY_NOTICE };
export const ACTION_PRIVACY_LINE =
  `The review runs on your own GitHub Actions runner. ${ACTION_GATEWAY_NOTICE} GitHub stores the findings as a workflow artifact.`;

const PRIO = new Set(['P0', 'P1', 'P2', 'P3']);
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_TITLE_RE = /^MegaLens (?:standard|deep) [0-9a-f]{40}\.\.([0-9a-f]{40})$/;

// GitHub CLI reports the missing branch PR separately from errors resolving the checkout or querying GitHub.
const NO_PR_RE = /^no pull requests found for branch "(?:[^"\\]|\\.)+"$/;

const jsonOf = (s) => { try { return JSON.parse(s); } catch { return null; } };
const oneLine = (s, n) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/```+/g, '` ` `')
    .trim()
    .slice(0, n);

/**
 * Full credential scrubber for model-written / untrusted finding fields (including file paths, titles, claims, snippets).
 * Covers exact env secrets, MegaLens/OpenAI/GitHub/Bearer shapes (`scrub`), plus AWS, GitLab, Slack, Google, and JWT shapes.
 */
export function scrubModelText(text, env = {}) {
  return scrub(text, env)
    .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, '[redacted]');
}

const sortF = (a, b) =>
  String(a.priority ?? 'P9').localeCompare(String(b.priority ?? 'P9')) ||
  String(a.file ?? '').localeCompare(String(b.file ?? '')) ||
  (a.line_start ?? 0) - (b.line_start ?? 0);

/** Deterministic finding order matching renderResult: Strong findings first, then Other findings. */
export function orderFindings(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.findings)) return [];
  const fs = doc.findings.filter((f) => f && typeof f === 'object');
  const strong = fs.filter((f) => f.strength === 'strong').sort(sortF);
  const rest = fs.filter((f) => f.strength !== 'strong').sort(sortF);
  return [...strong, ...rest];
}

export function formatLocation(f, env = null) {
  const rawFile = typeof f?.file === 'string' && f.file ? oneLine(f.file, 200).replace(/`/g, "'") : null;
  if (!rawFile) return '(no file named)';
  const file = env !== null ? scrubModelText(rawFile, env) : rawFile;
  const pos = (n) => Number.isInteger(n) && n > 0;
  return `${file}${pos(f.line_start) ? `:${f.line_start}${pos(f.line_end) && f.line_end !== f.line_start ? `-${f.line_end}` : ''}` : ''}`;
}

/**
 * Build a plain-text fix prompt ready to paste into Cursor, Claude Code, Lovable, Bolt or Copilot.
 * Scrubbed, fence-safe, no code beyond the finding's own bounded snippet (if present).
 */
export function formatFixPrompt(finding, { env = {}, reviewId = null, runUrl = null } = {}) {
  if (!finding || typeof finding !== 'object') throw new Error('No finding supplied.');
  const sc = (v, n) => scrubModelText(oneLine(v, n), env);
  const loc = sc(formatLocation(finding, env), 240);
  const prio = PRIO.has(finding.priority) ? finding.priority : 'P2';
  const title = sc(finding.title ?? finding.summary ?? 'Reported issue', 200);
  const claim = sc(finding.claim ?? '', 600);
  const failure = sc(finding.failure_scenario ?? '', 600);
  const expected = sc(finding.expected ?? finding.expected_behavior ?? finding.fix ?? '', 600);
  const rawSnippet = typeof finding.snippet === 'string' ? finding.snippet : (typeof finding.evidence_quote === 'string' ? finding.evidence_quote : '');
  const snippet = rawSnippet
    ? scrubModelText(
        rawSnippet
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
          .replace(/```+/g, '` ` `')
          .trim()
          .slice(0, 500),
        env,
      )
    : '';

  const lines = [
    `Fix this ${prio} issue in ${loc}:`,
    `What is wrong: ${title}`,
  ];
  if (claim && claim !== title) lines.push(`Why: ${claim}`);
  if (failure) lines.push(`Failure scenario: ${failure}`);
  if (expected) {
    lines.push(`Expected behaviour: ${expected}`);
  } else {
    lines.push('Expected behaviour: Verify the bug against the surrounding code and handle this case cleanly without breaking callers.');
  }
  if (snippet) {
    lines.push(`Relevant line(s) from finding: ${snippet.replace(/\r?\n/g, ' | ')}`);
  }
  if (reviewId) lines.push(`Source review: ${scrubExact(oneLine(reviewId, 80), env)}${runUrl ? ` (${scrubExact(oneLine(runUrl, 200), env)})` : ''}`);
  lines.push('Change only what is needed, keep the tests passing, and add a test.');
  return lines.join('\n');
}

export function formatFixPromptBlock(finding, opts = {}) {
  const env = opts.env || {};
  const prompt = formatFixPrompt(finding, opts);
  const loc = formatLocation(finding, env);
  const prio = PRIO.has(finding.priority) ? finding.priority : 'P2';
  const title = scrubModelText(oneLine(finding.title ?? 'Reported issue', 160), env);
  return `### Fix prompt — ${prio} \`${loc}\`: ${title}\n\n\`\`\`text\n${prompt}\n\`\`\`\n`;
}

// ---- Private local state & result cache under ~/.megalens/cursor/ (mode 0700 / 0600, never inside repo; never stores tokens) ----

export function cursorStateDir(home = homedir()) {
  return path.join(home, '.megalens', 'cursor');
}

function repoKey(identifier) {
  return createHash('sha256').update(String(identifier || 'default'), 'utf8').digest('hex').slice(0, 16);
}

function writePrivateJson(filePath, obj) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  try {
    if (lstatSync(filePath).isSymbolicLink()) return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const tmp = path.join(dir, `.state.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(obj, null, 2) + '\n');
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, filePath);
}

function readPrivateJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    if (lstatSync(filePath).isSymbolicLink()) return null;
    const j = JSON.parse(readFileSync(filePath, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

export function saveLastRun(stateDir, repoId, record) {
  writePrivateJson(path.join(stateDir, `${repoKey(repoId)}-last.json`), record);
}

export function loadLastRun(stateDir, repoId) {
  return readPrivateJson(path.join(stateDir, `${repoKey(repoId)}-last.json`));
}

/** Cache scrubbed findings only when GitHub supplies a run attempt. */
export function saveCachedResult(stateDir, repoId, { runId, attempt, url, doc, env = {}, exitCode = 0 }) {
  if (!Number.isInteger(attempt) || attempt < 1 || doc?.schema !== 'megalens.findings/v1' || !Array.isArray(doc.findings)) return;
  const passes = Array.isArray(doc.passes) ? doc.passes : [];
  const failedPasses = passes.filter((p) => p && p.status === 'failed');
  const effStatus = effectiveStatus(doc, passes, failedPasses, exitCode);
  const cleanFindings = orderFindings(doc).map((f, idx) => ({
    index: idx + 1,
    id: scrubModelText(oneLine(f.id ?? `f${idx + 1}`, 64), env),
    file: typeof f.file === 'string' ? scrubModelText(oneLine(f.file, 200), env) : null,
    line_start: Number.isInteger(f.line_start) ? f.line_start : null,
    line_end: Number.isInteger(f.line_end) ? f.line_end : null,
    priority: PRIO.has(f.priority) ? f.priority : 'P2',
    strength: f.strength === 'strong' ? 'strong' : 'normal',
    title: scrubModelText(oneLine(f.title, 200), env),
    claim: scrubModelText(oneLine(f.claim, 600), env),
    failure_scenario: scrubModelText(oneLine(f.failure_scenario, 600), env),
    expected: scrubModelText(oneLine(f.expected ?? f.expected_behavior ?? '', 600), env),
  }));
  writePrivateJson(path.join(stateDir, `${repoKey(repoId)}-result.json`), {
    runId,
    attempt,
    url: url ? scrubExact(String(url).slice(0, 300), env) : null,
    reviewId: scrubModelText(oneLine(doc.review_id ?? '', 70), env),
    tier: oneLine(doc.tier ?? '', 20),
    status: effStatus,
    savedAt: new Date().toISOString(),
    findings: cleanFindings,
  });
}

export function loadCachedResult(stateDir, repoId) {
  return readPrivateJson(path.join(stateDir, `${repoKey(repoId)}-result.json`));
}

/** Cross-platform clipboard writer (no shell). Returns { copied, tool } or { copied: false, reason }. */
export function realCopyToClipboard(text, platform = process.platform) {
  const candidates =
    platform === 'darwin'
      ? [['pbcopy', []]]
      : platform === 'win32'
        ? [['clip', []]]
        : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];

  return new Promise((resolve) => {
    const tryNext = (idx) => {
      if (idx >= candidates.length) return resolve({ copied: false, reason: 'no clipboard utility found' });
      const [cmd, args] = candidates[idx];
      let child;
      try {
        child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      } catch {
        return tryNext(idx + 1);
      }
      let settled = false;
      child.on('error', () => { if (!settled) { settled = true; tryNext(idx + 1); } });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          if (code === 0) resolve({ copied: true, tool: cmd });
          else tryNext(idx + 1);
        }
      });
      child.stdin.on('error', () => {});
      try { child.stdin.end(text, 'utf8'); } catch {}
    };
    tryNext(0);
  });
}

// ---- GitHub repo / PR / latest-run helpers ----

async function getRepoInfo({ exec, cwd, env }) {
  const rv = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url,isInOrganization'], { cwd, env: ghEnv(env) });
  const j = rv.code === 0 ? jsonOf(rv.stdout) : null;
  if (!j || typeof j.nameWithOwner !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(j.nameWithOwner)) return null;
  return {
    nwo: j.nameWithOwner,
    defaultBranch: typeof j.defaultBranchRef?.name === 'string' ? j.defaultBranchRef.name : 'main',
    url: typeof j.url === 'string' ? j.url : `https://github.com/${j.nameWithOwner}`,
    isInOrganization: j.isInOrganization,
  };
}

/**
 * Resolve PR base & head refs when `--pr <number>` is given, or auto-detect an open PR for the current branch.
 * - Explicit `--pr <number>`: passes `<number>` and `-R nwo` (positional selector present).
 * - Auto-detect (`pr === null`): uses checkout context (`gh pr view --json ...` WITHOUT `-R`, because GitHub CLI
 *   rejects `--repo` when no PR selector is provided).
 * - Distinguishes genuine absence of a PR (`NO_PR_RE`) from lookup errors so we never silently fall back to the
 *   default branch or skip the fork check on an error.
 * Refuses cross-repository (fork) PRs cleanly per the GitHub Action fork policy.
 */
export async function resolvePrTarget({ exec, cwd, env, pr = null, nwo = null }) {
  const args = ['pr', 'view'];
  if (pr !== null) {
    if (!PR_NUMBER_RE.test(String(pr))) return { error: `Invalid PR number: ${String(pr).slice(0, 40)}. Give digits only, e.g. --pr 42.` };
    args.push(String(pr));
  }
  args.push('--json', 'number,baseRefOid,headRefOid,url,isCrossRepository,state');
  // Only pass -R when an explicit PR selector is present; `gh pr view` rejects `--repo` without a selector.
  if (pr !== null && nwo) args.push('-R', nwo);
  const r = await exec('gh', args, { cwd, env: ghEnv(env) });
  if (r.code !== 0) {
    const errLine = scrub(r.stderr.trim().split('\n').filter(Boolean).pop() || 'gh pr view failed', env);
    if (pr !== null) return { error: `Could not find pull request #${pr}: ${errLine}.` };
    if (NO_PR_RE.test(r.stderr.trim())) {
      return { pr: null }; // genuine absence of a PR for the current branch; caller falls back to default branch merge-base
    }
    return {
      error: `Could not check whether the current branch has an open pull request (${errLine}). Nothing was started and no credit was used. Fix \`gh\` access or pass \`--base <ref> --head <ref>\` or \`--pr <number>\`.`,
    };
  }
  const j = jsonOf(r.stdout);
  if (!j || !Number.isInteger(j.number)) {
    if (pr !== null) return { error: `Could not parse pull request #${pr} details from gh.` };
    return {
      error: 'Could not parse pull request details from `gh pr view`. Nothing was started and no credit was used. Pass `--base <ref> --head <ref>` or `--pr <number>`.',
    };
  }
  if (pr === null && (j.state === 'CLOSED' || j.state === 'MERGED')) {
    return { pr: null };
  }
  if (j.isCrossRepository === true) {
    return {
      error: `PR #${j.number} is from a fork repository. Per the MegaLens Action fork policy, fork PRs are not run automatically from this command; inspect the fork PR on GitHub and comment \`/megalens review\` if you have maintainer access.`,
    };
  }
  const baseSha = typeof j.baseRefOid === 'string' && SHA_RE.test(j.baseRefOid) ? j.baseRefOid : null;
  const headSha = typeof j.headRefOid === 'string' && SHA_RE.test(j.headRefOid) ? j.headRefOid : null;
  if (!baseSha || !headSha || j.isCrossRepository !== false || (pr === null && j.state !== 'OPEN')) {
    return { error: `Could not verify the comparison range for PR #${j.number}. Nothing was started and no credit was used.` };
  }
  return {
    pr: {
      number: j.number,
      baseSha,
      headSha,
      url: typeof j.url === 'string' ? j.url : '',
    },
  };
}

/** Find the latest MegaLens Dispatch run for this repo (preferring current HEAD commit). */
export async function findLatestRun({ exec, cwd, env, stateDir = cursorStateDir(), requireCurrentHead = false }) {
  const repo = await getRepoInfo({ exec, cwd, env });
  if (!repo) {
    return { error: 'Could not determine the GitHub repository for this folder. Run `gh auth status` and open a folder with a GitHub remote.' };
  }
  const headRes = await exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, env: ghEnv(env) });
  const headSha = headRes.code === 0 && SHA_RE.test(headRes.stdout.trim()) ? headRes.stdout.trim() : null;
  if (requireCurrentHead && !headSha) {
    return { error: 'Could not read the current commit. Pass the review run explicitly with `--id gh:<id>`.' };
  }

  const listRes = await exec(
    'gh',
    ['run', 'list', '--workflow', WORKFLOW_FILE, '--event', 'workflow_dispatch', '--limit', '15', '--json', 'databaseId,displayTitle,status,conclusion,createdAt,url', '-R', repo.nwo],
    { cwd, env: ghEnv(env) },
  );
  const rows = listRes.code === 0 ? jsonOf(listRes.stdout) : null;
  if (requireCurrentHead && !Array.isArray(rows)) {
    return { error: 'Could not verify the latest MegaLens review for the current commit. Check GitHub CLI access or pass `--id gh:<id>`.' };
  }
  if (Array.isArray(rows) && rows.length > 0) {
    const valid = rows.filter((x) => Number.isSafeInteger(x?.databaseId) && x.databaseId > 0);
    const exactHead = headSha
      ? valid.find((x) => typeof x.displayTitle === 'string' && RUN_TITLE_RE.exec(x.displayTitle)?.[1] === headSha)
      : null;
    const picked = exactHead || (requireCurrentHead ? null : valid[0]);
    if (picked) {
      return {
        repo,
        id: `gh:${picked.databaseId}`,
        url: typeof picked.url === 'string' ? picked.url : `https://github.com/${repo.nwo}/actions/runs/${picked.databaseId}`,
        status: picked.status,
        conclusion: picked.conclusion,
        matchedHead: Boolean(exactHead),
      };
    }
  }
  if (requireCurrentHead) {
    return { error: 'No recent MegaLens review matches the current commit. Run `/megalens-review` or pass `--id gh:<id>` for a specific review.' };
  }
  const saved = loadLastRun(stateDir, repo.nwo);
  if (saved && isRunnerId(saved.id) && (!headSha || !saved.headSha || saved.headSha === headSha)) {
    return { repo, id: saved.id, url: saved.url || null, matchedHead: Boolean(headSha && saved.headSha === headSha), fromSavedState: true };
  }
  return { error: `No MegaLens review runs found in ${repo.nwo}. Run \`/megalens-review\` first to start a review.` };
}

/** Rewrite Claude Code slash command names in runner messages to Cursor slash command names. */
export function adaptTextForCursor(text) {
  return String(text ?? '')
    .replace(/\/megalens:review\b/g, '/megalens-review')
    .replace(/\/megalens:status\b/g, '/megalens-status')
    .replace(/\/megalens:result\b/g, '/megalens-result');
}

/** Command 1: Review current branch or PR on the user's GitHub Actions runner. */
export async function cursorReview({
  exec = realExec,
  cwd = process.cwd(),
  env = process.env,
  tier = 'standard',
  base = null,
  head = null,
  pr = null,
  allowGateway = false,
  wait = false,
  stateDir = cursorStateDir(),
  runnerTiming = {},
} = {}) {
  if (tier === 'double') return { code: 4, text: `${DOUBLE_OFF_MESSAGE}\n` };
  if (tier !== 'standard' && tier !== 'deep') return { code: 4, text: 'Tier must be standard or deep.\n' };
  if ((base === null) !== (head === null)) return { code: 4, text: '--base and --head go together.\n' };
  if (base !== null && (!REF_RE.test(base) || !REF_RE.test(head))) {
    return { code: 4, text: '--base and --head must be plain git refs or commit SHAs.\n' };
  }
  if (pr !== null && (base !== null || head !== null)) {
    return { code: 4, text: 'Pass either --pr <number> or --base/--head, not both.\n' };
  }
  if (allowGateway !== true) {
    return { code: 4, text: `${ACTION_GATEWAY_NOTICE} Confirm this transfer in Cursor or pass --allow-gateway in the CLI to start the review.\n` };
  }

  let effectiveBase = base;
  let effectiveHead = head;
  let prNote = '';
  const repo = await getRepoInfo({ exec, cwd, env });

  if (base === null && (pr === null || repo)) {
    const resolved = await resolvePrTarget({ exec, cwd, env, pr, nwo: repo?.nwo });
    if (resolved.error) return { code: 4, text: `${scrubExact(resolved.error, env)}\n` };
    if (resolved.pr) {
      effectiveBase = resolved.pr.baseSha;
      effectiveHead = pr === null ? 'HEAD' : resolved.pr.headSha;
      prNote = `PR #${resolved.pr.number}${resolved.pr.url ? ` (${resolved.pr.url})` : ''}: `;
    }
  } else if (pr !== null && !repo) {
    return { code: 4, text: 'Cannot resolve --pr without a GitHub repository remote. Run `gh auth status` and check `git remote -v`.\n' };
  }

  const r = await runnerReview({
    ...runnerTiming,
    exec,
    cwd,
    env,
    tier,
    base: effectiveBase,
    head: effectiveHead,
    requireClean: base === null && pr === null,
    allowGateway,
    wait,
  });

  if (r.id && repo) {
    const headRes = await exec('git', ['rev-parse', '--verify', `${effectiveHead ?? 'HEAD'}^{commit}`], { cwd, env: ghEnv(env) });
    const headSha = headRes.code === 0 && SHA_RE.test(headRes.stdout.trim()) ? headRes.stdout.trim() : null;
    saveLastRun(stateDir, repo.nwo, {
      id: r.id,
      repo: repo.nwo,
      tier,
      prNumber: pr ?? null,
      headSha,
      startedAt: new Date().toISOString(),
    });
  }
  const text = adaptTextForCursor(scrubExact(`${prNote}${r.text}`, env));
  return { code: r.code, text, id: r.id ?? null, setup: Boolean(r.setup), needsUser: Boolean(r.needsUser) };
}

/** Command 2a: Check status of an explicit run ID or the latest MegaLens run. */
export async function cursorStatus({
  exec = realExec,
  cwd = process.cwd(),
  env = process.env,
  id = null,
  stateDir = cursorStateDir(),
} = {}) {
  let targetId = id;
  if (!targetId) {
    const latest = await findLatestRun({ exec, cwd, env, stateDir });
    if (latest.error) return { code: 4, text: `${scrubExact(latest.error, env)}\n` };
    targetId = latest.id;
  }
  if (!isRunnerId(targetId)) {
    return { code: 4, text: 'That is not a GitHub review id (they look like gh:123456789).\n' };
  }
  const r = await runnerStatus({ exec, cwd, env }, targetId);
  return { code: r.code, text: adaptTextForCursor(scrubExact(r.text, env)), id: targetId, state: r.state };
}

/** Command 2b: Show the latest review result (or an explicit gh:<id>), numbering findings for /megalens-fix-prompt. */
export async function cursorLatestResult({
  exec = realExec,
  cwd = process.cwd(),
  env = process.env,
  id = null,
  stateDir = cursorStateDir(),
} = {}) {
  let targetId = id;
  let repo = await getRepoInfo({ exec, cwd, env });
  let latestNote = '';
  if (!targetId) {
    const latest = await findLatestRun({ exec, cwd, env, stateDir });
    if (latest.error) return { code: 4, text: `${scrubExact(latest.error, env)}\n` };
    targetId = latest.id;
    repo = latest.repo || repo;
    if (!latest.matchedHead) {
      latestNote = `Showing the latest MegaLens run in ${repo?.nwo || 'this repository'} (${targetId}).\n`;
    }
  }
  if (!isRunnerId(targetId)) {
    return { code: 4, text: 'That is not a GitHub review id (they look like gh:123456789).\n' };
  }
  const r = await runnerResult({ exec, cwd, env }, targetId);
  let extra = '';
  if (r.doc && typeof r.doc === 'object' && r.doc.schema === 'megalens.findings/v1') {
    const urlMatch = r.text.match(/^Run:\s*(\S+)/m);
    const runUrl = urlMatch ? urlMatch[1] : null;
    if (repo) saveCachedResult(stateDir, repo.nwo, { runId: targetId, attempt: r.attempt, url: runUrl, doc: r.doc, env, exitCode: r.code === 0 ? 0 : 4 });
    const ordered = orderFindings(r.doc);
    if (ordered.length > 0) {
      const idxLines = ordered.map(
        (f, i) => `  ${i + 1}. [${PRIO.has(f.priority) ? f.priority : 'P?'}] \`${formatLocation(f, env)}\` — ${scrubModelText(oneLine(f.title, 120), env)}`,
      );
      extra = `\n### Finding numbers (for \`/megalens-fix-prompt <number> --id ${targetId}\`)\n${idxLines.join('\n')}\n`;
    }
  }
  // Scrub model-generated lines with the full model scrubber while keeping the `Run: https://...` URL intact (so repo names like `ml-e2e-review-test` are never mangled).
  const safeBody = r.text
    .split('\n')
    .map((line) => (/^Run:\s+https?:\/\//.test(line) ? scrubExact(line, env) : scrubModelText(line, env)))
    .join('\n');
  const text = adaptTextForCursor(scrubExact(`${latestNote}${safeBody}${extra}`, env));
  return { code: r.code, text, id: targetId, doc: r.doc ?? null };
}

/** Command 3: Generate (and optionally copy to clipboard) a fix prompt for finding #<n> (or id, or --all). */
export async function cursorFixPrompt({
  exec = realExec,
  cwd = process.cwd(),
  env = process.env,
  selector = null,
  all = false,
  id = null,
  fromFile = null,
  copy = false,
  stateDir = cursorStateDir(),
  copyFn = realCopyToClipboard,
} = {}) {
  let findings = null;
  let reviewId = null;
  let runUrl = null;
  let statusWord = null;

  if (fromFile) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(fromFile, 'utf8'));
    } catch (e) {
      return { code: 4, text: `Could not read findings file: ${scrub(e.message, env)}\n` };
    }
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== 'megalens.findings/v1' || !Array.isArray(parsed.findings)) {
      return { code: 4, text: 'That file is not a valid megalens.findings/v1 result document.\n' };
    }
    const passes = Array.isArray(parsed.passes) ? parsed.passes : [];
    const failedPasses = passes.filter((p) => p && p.status === 'failed');
    statusWord = effectiveStatus(parsed, passes, failedPasses, 0);
    findings = orderFindings(parsed);
    reviewId = parsed.review_id || null;
  } else {
    // A numbered finding without a run ID must come from a run for the current checkout.
    let targetId = id;
    let repo = null;
    if (targetId) {
      if (!isRunnerId(targetId)) {
        return { code: 4, text: 'That is not a GitHub review id (they look like gh:123456789).\n' };
      }
      repo = await getRepoInfo({ exec, cwd, env });
    } else {
      const latest = await findLatestRun({ exec, cwd, env, stateDir, requireCurrentHead: true });
      if (latest.error) return { code: 4, text: `${scrubExact(latest.error, env)}\n` };
      targetId = latest.id;
      repo = latest.repo || null;
    }

    let loaded = null;
    if (repo) {
      const cached = loadCachedResult(stateDir, repo.nwo);
      if (cached?.runId === targetId && Number.isInteger(cached.attempt) && Array.isArray(cached.findings)) {
        const status = await runnerStatus({ exec, cwd, env }, targetId);
        if (status.state === 'done' && status.attempt === cached.attempt) loaded = cached;
      }
    }

    if (loaded) {
      findings = loaded.findings;
      reviewId = loaded.runId || loaded.reviewId;
      runUrl = loaded.url || null;
      statusWord = loaded.status || null;
    } else {
      const res = await cursorLatestResult({ exec, cwd, env, id: targetId, stateDir });
      if (!res.doc || !Array.isArray(res.doc.findings)) {
        return { code: 4, text: res.text };
      }
      findings = orderFindings(res.doc);
      reviewId = res.id || res.doc.review_id;
      const urlMatch = res.text.match(/^Run:\s*(\S+)/m);
      runUrl = urlMatch ? urlMatch[1] : null;
      const passes = Array.isArray(res.doc.passes) ? res.doc.passes : [];
      const failedPasses = passes.filter((p) => p && p.status === 'failed');
      statusWord = effectiveStatus(res.doc, passes, failedPasses, res.code === 0 ? 0 : 4);
    }
  }

  if (!findings || findings.length === 0) {
    const caveat = statusWord && statusWord !== 'complete'
      ? ` (note: review status is ${statusWord.toUpperCase()} — this is not a clean review)`
      : '';
    return { code: 4, text: `There are no findings in the latest review to build a fix prompt for${caveat}.\n` };
  }

  let selected = [];
  if (all) {
    selected = findings;
  } else if (selector === null || selector === undefined || selector === '') {
    if (findings.length === 1) {
      selected = [findings[0]];
    } else {
      const list = findings
        .map((f, i) => `${i + 1}. [${PRIO.has(f.priority) ? f.priority : 'P?'}] \`${formatLocation(f, env)}\` — ${scrubModelText(oneLine(f.title, 120), env)}`)
        .join('\n');
      const instruction = fromFile
        ? 'Pick a finding number or use `--all` with the same findings file.'
        : `Pick one with \`/megalens-fix-prompt <number> --id ${reviewId}\` or use \`--all --id ${reviewId}\`.`;
      return {
        code: 0,
        needsChoice: true,
        text: scrubExact(`This review has ${findings.length} findings. ${instruction}\n\n${list}\n`, env),
      };
    }
  } else {
    const rawSel = String(selector).replace(/^#/, '').trim();
    if (FINDING_INDEX_RE.test(rawSel)) {
      const idx = Number(rawSel) - 1;
      if (idx < 0 || idx >= findings.length) {
        return { code: 4, text: `Finding #${rawSel} does not exist (the latest review has ${findings.length} finding${findings.length === 1 ? '' : 's'}).\n` };
      }
      selected = [findings[idx]];
    } else if (FINDING_ID_RE.test(rawSel)) {
      const hit = findings.find((f) => String(f.id) === rawSel);
      if (!hit) return { code: 4, text: `Finding "${rawSel}" was not found in the latest review.\n` };
      selected = [hit];
    } else {
      return { code: 4, text: 'Invalid finding selector. Give a number (1, 2, ...), a finding id (f1), or --all.\n' };
    }
  }

  const plainPrompts = selected.map((f) => formatFixPrompt(f, { env, reviewId, runUrl }));
  const combinedPlain = plainPrompts.join('\n\n---\n\n');
  const blocks = selected.map((f) => formatFixPromptBlock(f, { env, reviewId, runUrl })).join('\n');

  let copyNote = '';
  if (copy) {
    const cr = await copyFn(combinedPlain);
    copyNote = cr.copied
      ? `\nCopied to your clipboard (via ${cr.tool}). Paste into Cursor Agent chat or any AI coding tool.\n`
      : `\nCould not copy automatically (${cr.reason}); use the Copy button on the code block above.\n`;
  } else {
    copyNote = '\nUse the Copy button on the code block above (or re-run with `--copy` to copy straight to your clipboard).\n';
  }

  return {
    code: 0,
    text: scrubExact(`${blocks}${copyNote}`, env),
    prompt: combinedPlain,
    count: selected.length,
  };
}

/**
 * Sign-in & GitHub Actions runner readiness summary.
 * - Clearly separates Cursor's native hosted MCP OAuth (managed inside Cursor's Customize panel) from the optional CLI keychain session.
 * - Checks `gh` CLI active login AND current repository runner readiness (workflow file on default branch + MEGALENS_TOKEN secret name check).
 * - Never reads, prints, or stores raw GitHub Actions secrets.
 */
export async function cursorSignInStatus({
  exec = realExec,
  cwd = process.cwd(),
  env = process.env,
  secretStore = createOsSecretStore(),
} = {}) {
  const oauth = await getAuthStatus(secretStore);
  const ghVer = await exec('gh', ['--version'], { cwd, env: ghEnv(env) });
  let ghLoggedIn = false;
  if (ghVer.code === 0) {
    let au = await exec('gh', ['auth', 'status', '--active'], { cwd, env: ghEnv(env) });
    if (au.code !== 0 && /unknown flag/i.test(au.stderr)) au = await exec('gh', ['auth', 'status'], { cwd, env: ghEnv(env) });
    ghLoggedIn = au.code === 0;
  }

  const runner = { repo: null, workflowPresent: null, secretPresent: null };
  if (ghLoggedIn) {
    const repo = await getRepoInfo({ exec, cwd, env });
    if (repo) {
      runner.repo = repo.nwo;
      const run = (cmd, args) => exec(cmd, args, { cwd, env: ghEnv(env) });
      const wf = await run('gh', ['api', '-X', 'GET', `repos/${repo.nwo}/contents/${WORKFLOW_PATH}`, '-f', `ref=${repo.defaultBranch}`, '--jq', '.type']);
      runner.workflowPresent = wf.code === 0 && wf.stdout.trim() === 'file';
      runner.secretPresent = (await actionSecretStatus(run, repo.nwo, repo.isInOrganization)).present;
    }
  }

  const lines = [
    '## MegaLens sign-in & runner readiness',
    `- GitHub CLI (\`gh\`): ${ghVer.code === 127 ? 'not installed (https://cli.github.com)' : ghLoggedIn ? 'signed in' : 'not signed in — run `gh auth login --hostname github.com --git-protocol https --web --scopes workflow` (browser sign-in).'}`,
  ];

  if (runner.repo) {
    lines.push(`- GitHub Actions workflow (\`${WORKFLOW_PATH}\` in \`${runner.repo}\`): ${runner.workflowPresent ? 'present on default branch' : `missing on default branch. Add the included template \`templates/${WORKFLOW_FILE}\` as \`${WORKFLOW_PATH}\` and push it to your default branch.`}`);
    const secMsg = runner.secretPresent === true
      ? `configured (\`${SECRET_NAME}\` repository/org secret found)`
      : runner.secretPresent === false
        ? `missing. ${ACTION_TOKEN_SETUP}`
        : `could not verify whether this repository can use \`${SECRET_NAME}\`.`;
    lines.push(`- GitHub Actions runner secret (\`${SECRET_NAME}\`): ${secMsg}`);
  } else if (ghLoggedIn) {
    lines.push('- GitHub Actions runner: open a folder with a GitHub remote to check workflow and secret readiness.');
  }

  lines.push(
    `- Privacy: ${ACTION_PRIVACY_LINE}`,
    '- Cursor hosted MCP (`megalens` OAuth) is managed inside Cursor. Open **Customize**, find **megalens** and click **Connect** to sign in through your browser.',
    `- Optional CLI keychain session (${oauth.backend}, hosted MCP only) ${oauth.signedIn ? `is signed in (${oauth.issuer}${oauth.expiresAt ? `, expires ${oauth.expiresAt}` : ''}).` : 'is signed out.'}`,
  );
  return { code: 0, text: lines.join('\n') + '\n', oauth, ghInstalled: ghVer.code === 0, ghLoggedIn, runner };
}
