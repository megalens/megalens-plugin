// Fixture tests (zero network) for the MegaLens GitHub App on-demand path:
//   GET /api/github-app/status, POST /api/github-app/review-now, GET /api/github-app/review-now/[id]
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  APP_BILLING_URL, APP_INSTALL_URL, APP_PATH_ENABLED, WORKFLOW_PATH,
  appResult, appReview, appStatus, checkAppStatus, extractAppToken, isAppId, parseGitHubRemote, resolveAppApiBase, resolveClaudeMcpConfigPath,
} from '../scripts/lib/gh-runner.mjs';
import { canSaveLatestReview, loadLatestReview, saveLatestReview, stateFilePath } from '../scripts/lib/latest-review.mjs';
import { DEFAULT_WAIT_MS, STILL_RUNNING_LINE } from '../scripts/lib/wait-loop.mjs';
import { main } from '../scripts/engine.mjs';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TOKEN = 'ml_tok_' + '9'.repeat(32);
const JOB1 = '11111111-1111-4111-8111-111111111111';
const JOB2 = '22222222-2222-4222-8222-222222222222';
const SETUP_LINE = `Install the MegaLens GitHub App or add the workflow: ${APP_INSTALL_URL}`;
const COMMIT_SCOPE = `This review is limited to commit \`${H.slice(0, 7)}\` (the changes since its first parent). To review the whole branch, sign in to \`gh\` and use an open pull request from the same repository that is ready for review.`;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'err', code = 1) => ({ code, stdout: '', stderr });

function fakeClock() {
  let t = 1_732_380_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms, signal) => {
      if (signal?.aborted) return;
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms) => { t += ms; },
    sleeps,
  };
}

function makeDoc(extra = {}) {
  return {
    schema: 'megalens.findings/v1',
    review_id: 'rv_app12345',
    tier: 'standard',
    status: 'complete',
    passes: [{ name: 'codex-standard', model: 'gpt-6.2-sol', effort: 'medium', status: 'ok' }],
    findings: [{
      id: 'f1',
      file: 'src/checkout.js',
      line_start: 14,
      line_end: 16,
      title: 'Off-by-one in discount calculation',
      claim: 'Applies discount twice on subtotal',
      failure_scenario: 'Customer pays 81% instead of 90%',
      priority: 'P1',
      strength: 'strong',
      found_by: ['codex-standard'],
    }],
    ...extra,
  };
}

function makeJob(overrides = {}) {
  return {
    job_id: JOB1,
    status: 'done',
    reason: null,
    result_status: 'complete',
    tier: 'standard',
    head_sha: H,
    findings: makeDoc(),
    pr_url: null,
    check_url: 'https://github.com/acme/widget/runs/777',
    ...overrides,
  };
}

function jsonResp(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...headers },
  });
}

function makeGitGhExec({
  repoRoot = '/repo-app',
  nwo = 'acme/widget',
  repoUrl = `https://github.com/${nwo}`,
  defaultBranch = 'main',
  hasGh = true,
  remoteUrl = `https://github.com/${nwo}.git`,
  workflowPresent = false,
  dirty = false,
  pushed = true,
  openPr = null,
  upstreamRef = '',
  upstreamRemote = 'origin',
  upstreamUrl = remoteUrl,
  authError = null,
  repoLookupError = null,
  prLookupError = null,
  existingRuns = [],
  runsAfterDispatch = null,
} = {}) {
  const calls = [];
  let dispatched = false;
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const k = `${cmd} ${args.slice(0, 2).join(' ')}`;
    if (cmd === 'gh' && !hasGh) return bad('gh: command not found', 127);
    if (k.startsWith('gh --version')) return ok('gh version 2.60.0');
    if (k.startsWith('gh auth')) return authError ? bad(authError) : ok('Logged in');
    if (k.startsWith('gh repo')) return repoLookupError ? bad(repoLookupError) : ok(JSON.stringify({ nameWithOwner: nwo, defaultBranchRef: { name: defaultBranch }, url: repoUrl }));
    if (k.startsWith('gh pr') && prLookupError) return bad(prLookupError);
    if (k.startsWith('gh pr')) return openPr ? ok(JSON.stringify(openPr)) : bad('no pull requests found for branch');
    if (k.startsWith('gh secret')) return ok(JSON.stringify([{ name: 'MEGALENS_TOKEN' }]));
    if (k.startsWith('gh api') && args.some((a) => a.includes('/contents/'))) return workflowPresent ? ok('file\n') : bad('HTTP 404');
    if (k.startsWith('gh api') && args.some((a) => a.includes('/commits/'))) return pushed ? ok(`${H}\n`) : bad('HTTP 422');
    if (k.startsWith('gh workflow run')) { dispatched = true; return ok(''); }
    if (k.startsWith('gh run list')) {
      const rows = runsAfterDispatch ?? [{ databaseId: 9001, displayTitle: `MegaLens standard ${B}..${H}`, createdAt: new Date().toISOString(), url: `https://github.com/${nwo}/actions/runs/9001` }];
      return ok(JSON.stringify(dispatched ? [...rows, ...existingRuns] : existingRuns));
    }
    if (k.startsWith('gh run view')) {
      return ok(JSON.stringify({ status: 'completed', conclusion: 'success', url: `https://github.com/${nwo}/actions/runs/9001`, workflowName: 'MegaLens Dispatch', displayTitle: `MegaLens standard ${B}..${H}` }));
    }
    if (k.startsWith('git rev-parse') && args.includes('--show-toplevel')) return ok(`${repoRoot}\n`);
    if (k.startsWith('git rev-parse')) return ok(`${H}\n`);
    if (k.startsWith('git merge-base')) return ok(`${B}\n`);
    if (k.startsWith('git status')) return ok(dirty ? ' M src/a.js\n' : '');
    if (k.startsWith('git branch') && args.includes('--show-current')) return ok('feat/payments\n');
    if (k.startsWith('git branch') && args.includes('--contains')) return ok(pushed ? '  origin/feat/payments\n' : '');
    if (cmd === 'git' && args[0] === 'for-each-ref') {
      assert.deepEqual(args, [
        'for-each-ref', '--format=%(upstream:remotename)%09%(upstream:remoteref)', 'refs/heads/feat/payments',
      ]);
      return ok(`${upstreamRef ? upstreamRemote : ''}\t${upstreamRef}\n`);
    }
    if (k.startsWith('git remote') && args.at(-1) === upstreamRemote) return upstreamUrl ? ok(`${upstreamUrl}\n`) : bad('no such remote');
    if (k.startsWith('git remote')) return remoteUrl ? ok(`${remoteUrl}\n`) : bad('no such remote');
    return bad(`unexpected: ${k} ${args.join(' ')}`, 99);
  };
  return { exec, calls };
}

function makeAppServer({
  statusResp = { installed: true, linked: true, notice_accepted: true, suspended: false },
  statusHttp = 200,
  submitHandler = null,
  pollSequence = [makeJob()],
  pollHandler = null,
} = {}) {
  const requests = [];
  let pollIdx = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url: u.toString(), pathname: u.pathname, search: u.search, headers: init.headers, redirect: init.redirect, body });

    if (method === 'GET' && u.pathname === '/api/github-app/status') {
      return jsonResp(statusHttp, statusResp);
    }
    if (method === 'POST' && u.pathname === '/api/github-app/review-now') {
      if (submitHandler) return await submitHandler({ u, init, body, requests });
      const statusUrl = `/api/github-app/review-now/${JOB1}`;
      return jsonResp(202, { job_id: JOB1, status_url: statusUrl }, { location: statusUrl });
    }
    if (method === 'GET' && u.pathname.startsWith('/api/github-app/review-now/')) {
      const id = u.pathname.slice('/api/github-app/review-now/'.length);
      if (pollHandler) return await pollHandler({ id, u, init, requests });
      const item = pollSequence[Math.min(pollIdx++, pollSequence.length - 1)];
      if (item instanceof Response) return item;
      return jsonResp(200, item);
    }
    return jsonResp(404, { error: 'not_found' });
  };
  return { fetch, requests };
}

async function runCli(argv, { exec, fetch, stateDir, cwd = '/repo-app', env = {}, timing = {}, signal = null, onOutput = null } = {}) {
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), 'mlapp-'));
  let text = '';
  let errText = '';
  const code = await main(argv, {
    exec,
    fetch,
    cwd,
    env: { PATH: process.env.PATH, HOME: dir, MEGALENS_STATE_DIR: dir, MEGALENS_TOKEN: TOKEN, GH_TOKEN: 'ghp_test1234567890', ...env },
    out: (s) => { text += s; onOutput?.(s); },
    err: (s) => { errText += s; },
    flags: { runnerTiming: { sleepMs: 1, tries: 2, ...timing } },
    signal,
  });
  return { code, text, errText, stateDir: dir };
}

test('APP_PATH_ENABLED is true and UUID app ids are validated', () => {
  assert.equal(APP_PATH_ENABLED, true);
  assert.equal(isAppId(`app:${JOB1}`), true);
  assert.equal(isAppId(`app:${JOB1.toUpperCase()}`), true);
  for (const badId of ['app:', 'app:55501', 'app:not-a-uuid', `app:${JOB1};rm`, 'gh:123', 'rv_abc12345']) {
    assert.equal(isAppId(badId), false, badId);
  }
});

test('App installed (standard + ref): starts via review-now, prints progress and inline findings with no ids or commands', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-ok-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const clk = fakeClock();
  const gh = makeGitGhExec({ workflowPresent: true });
  const srv = makeAppServer({
    pollSequence: [
      makeJob({ status: 'queued', result_status: null, findings: null }),
      ...Array.from({ length: 9 }, () => makeJob({ status: 'running', result_status: null, findings: null })),
      makeJob(),
    ],
  });

  const r = await runCli(['review'], { exec: gh.exec, fetch: srv.fetch, stateDir, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Review started\nWaiting for MegaLens review machine\.\.\.\nRunning on MegaLens\.\.\.\nAbout 2 minutes so far\n/);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.match(r.text, /Off-by-one in discount calculation/);
  // Clean path must NOT expose ids or status/result commands
  assert.equal(r.text.includes(JOB1), false, 'no job UUID on clean completion');
  assert.equal(r.text.includes('rv_app12345'), false, 'no rv_ id on clean completion');
  assert.equal(r.text.includes('/megalens:status'), false);
  assert.equal(r.text.includes('/megalens:result'), false);
  // Workflow must NOT be dispatched when App is installed
  assert.equal(gh.calls.some((c) => c.args[0] === 'workflow'), false);
  // Verify exact contract: status -> POST review-now -> GET review-now/[id]
  assert.equal(srv.requests[0].method, 'GET');
  assert.equal(srv.requests[0].pathname, '/api/github-app/status');
  assert.equal(srv.requests[0].search, '?repo=acme%2Fwidget');
  assert.equal(srv.requests[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(srv.requests[0].redirect, 'manual');
  assert.equal(srv.requests[1].method, 'POST');
  assert.equal(srv.requests[1].pathname, '/api/github-app/review-now');
  assert.deepEqual(srv.requests[1].body, { repo: 'acme/widget', tier: 'standard', ref: H });
  assert.equal(srv.requests[2].pathname, `/api/github-app/review-now/${JOB1}`);
  // Token never passed to gh/git subprocesses or printed or saved in bookmark
  assert.equal(r.text.includes(TOKEN), false);
  for (const c of gh.calls) {
    assert.equal(c.env?.MEGALENS_TOKEN, undefined);
    assert.equal(JSON.stringify(c.args).includes(TOKEN), false);
  }
  const sf = stateFilePath({ MEGALENS_STATE_DIR: stateDir });
  assert.equal(statSync(sf).mode & 0o777, 0o600);
  assert.equal(readFileSync(sf, 'utf8').includes(TOKEN), false);
});

test('App installed (deep + open PR): sends {repo, tier: "deep", pr} and renders deep findings inline', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-deep-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec({
    openPr: {
      number: 42,
      state: 'OPEN',
      isDraft: false,
      headRefOid: H,
      baseRefOid: B,
      isCrossRepository: false,
      url: 'https://github.com/acme/widget/pull/42',
    },
  });
  const srv = makeAppServer({
    pollSequence: [makeJob({ tier: 'deep', pr_url: 'https://github.com/acme/widget/pull/42', findings: makeDoc({ tier: 'deep' }) })],
  });

  const r = await runCli(['review', 'deep'], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /## MegaLens deep review: complete/);
  assert.doesNotMatch(r.text, /This review is limited to commit/);
  const post = srv.requests.find((x) => x.method === 'POST');
  assert.deepEqual(post.body, { repo: 'acme/widget', tier: 'deep', pr: 42 });
  assert.equal(r.text.includes(JOB1), false);
  const prCall = gh.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr');
  assert.ok(prCall, 'expected gh pr view call');
  assert.deepEqual(prCall.args.slice(0, 5), ['pr', 'view', 'feat/payments', '-R', 'github.com/acme/widget']);
  assert.match(prCall.args.join(' '), /\burl\b/);
});

test('App installed without gh CLI installed: resolves owner/repo from git origin and runs App review', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-nogh-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec({ hasGh: false, remoteUrl: 'git@github.com:acme/widget.git' });
  const srv = makeAppServer();

  const r = await runCli(['review'], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.equal(parseGitHubRemote('git@github.com:acme/widget.git'), 'acme/widget');
  assert.equal(parseGitHubRemote('https://github.com/acme/widget.git'), 'acme/widget');
  assert.equal(parseGitHubRemote('https://gitlab.com/acme/widget.git'), null);
});

test('App discloses commit scope before submitting a ref and with fresh or saved results', async (t) => {
  for (const [name, ghOptions] of [['without gh', { hasGh: false }], ['without a pull request', {}]]) {
    await t.test(name, async (t) => {
      const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-commit-scope-'));
      t.after(() => rmSync(stateDir, { recursive: true, force: true }));
      const gh = makeGitGhExec(ghOptions);
      let streamed = '';
      let outputBeforePost = '';
      const srv = makeAppServer({
        submitHandler: () => {
          outputBeforePost = streamed;
          return jsonResp(202, { job_id: JOB1 });
        },
        pollSequence: [makeJob({ findings: makeDoc({ findings: [] }) })],
      });
      const ctx = { exec: gh.exec, fetch: srv.fetch, stateDir };

      const fresh = await runCli(['review'], { ...ctx, onOutput: (line) => { streamed += line; } });
      assert.equal(fresh.code, 0, fresh.text);
      assert.ok(outputBeforePost.includes(`${COMMIT_SCOPE}\n`), 'scope must reach output before the POST');
      assert.ok(fresh.text.includes(`${COMMIT_SCOPE}\n\n## MegaLens standard review: complete`), fresh.text);
      assert.match(fresh.text, /No findings were reported by a complete review/);

      for (const args of [['review'], ['review', '--runner', 'app'], ['result'], ['result', `app:${JOB1}`]]) {
        const saved = await runCli(args, ctx);
        assert.equal(saved.code, 0, saved.text);
        assert.ok(saved.text.includes(`${COMMIT_SCOPE}\n\n## MegaLens standard review: complete`), saved.text);
      }
      assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
        { repo: 'acme/widget', tier: 'standard', ref: H },
      ]);
    });
  }
});

test('App reviews pushed commits when gh is installed without a GitHub login', async (t) => {
  for (const runnerArgs of [[], ['--runner', 'app']]) {
    for (const detached of [false, true]) {
      const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-gh-logged-out-'));
      t.after(() => rmSync(stateDir, { recursive: true, force: true }));
      const gh = makeGitGhExec({ authError: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' });
      const authenticatedCalls = [];
      const exec = (cmd, args, opts) => {
        if (cmd === 'git' && detached && args.join(' ') === 'branch --show-current') return ok('');
        if (cmd === 'gh' && !['--version', 'auth'].includes(args[0])) {
          authenticatedCalls.push(args[0]);
          return bad('To get started with GitHub CLI, please run: gh auth login', 4);
        }
        return gh.exec(cmd, args, opts);
      };
      const srv = makeAppServer();

      const result = await runCli(['review', ...runnerArgs], {
        exec, fetch: srv.fetch, stateDir, env: { GH_TOKEN: undefined },
      });
      assert.equal(result.code, 0, result.text);
      assert.match(result.text, /## MegaLens standard review: complete/);
      assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
        { repo: 'acme/widget', tier: 'standard', ref: H },
      ]);
      assert.deepEqual(authenticatedCalls, []);
    }
  }
});

test('App reviews pushed commits when gh knows another host but has no github.com login', async (t) => {
  for (const runnerArgs of [[], ['--runner', 'app']]) {
    for (const detached of [false, true]) {
      const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-gh-other-host-'));
      t.after(() => rmSync(stateDir, { recursive: true, force: true }));
      const gh = makeGitGhExec({
        authError: detached ? null : 'HTTP 502 checking another GitHub host',
        repoLookupError: 'GraphQL: Requires authentication',
      });
      const githubCalls = [];
      const exec = (cmd, args, opts) => {
        if (cmd === 'git' && detached && args.join(' ') === 'branch --show-current') return ok('');
        if (cmd === 'gh' && args[0] === 'auth' && args.includes('--hostname')) {
          assert.equal(args.at(-1), 'github.com');
          return bad('You are not logged into any accounts on github.com\n');
        }
        if (cmd === 'gh' && ['pr', 'api'].includes(args[0])) {
          githubCalls.push(args[0]);
          return bad('GraphQL: Requires authentication');
        }
        return gh.exec(cmd, args, opts);
      };
      const srv = makeAppServer();

      const result = await runCli(['review', ...runnerArgs], {
        exec, fetch: srv.fetch, stateDir, env: { GH_TOKEN: undefined },
      });
      assert.equal(result.code, 0, result.text);
      assert.match(result.text, /## MegaLens standard review: complete/);
      assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
        { repo: 'acme/widget', tier: 'standard', ref: H },
      ]);
      assert.deepEqual(githubCalls, []);
    }
  }
});

const openPaymentPr = {
  number: 42,
  state: 'OPEN',
  isDraft: false,
  isCrossRepository: false,
  headRefOid: H,
  baseRefOid: B,
  baseRefName: 'main',
  url: 'https://github.com/acme/widget/pull/42',
};

test('App finds the PR by the upstream branch name when the local branch has a different name', async (t) => {
  for (const [remoteBranch, selector] of [['release/payments', 'release/payments'], ['42', 'acme:42']]) {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-upstream-'));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const gh = makeGitGhExec({ upstreamRef: `refs/heads/${remoteBranch}`, openPr: openPaymentPr });
    const exec = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[2] !== selector) {
        return bad(`no pull requests found for branch "${args[2]}"`);
      }
      return gh.exec(cmd, args, opts);
    };
    const srv = makeAppServer({ pollSequence: [makeJob({ pr_url: openPaymentPr.url })] });

    const result = await runCli(['review'], { exec, fetch: srv.fetch, stateDir });
    assert.equal(result.code, 0, result.text);
    assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
      { repo: 'acme/widget', tier: 'standard', pr: 42 },
    ]);
    assert.match(result.text, /Off-by-one in discount calculation/);
  }
});

test('App finds the feature PR when its branch tracks a base or a different repository', async (t) => {
  const cases = [
    { upstreamRef: 'refs/heads/main', prBranches: ['main', 'feat/payments'] },
    {
      upstreamRef: 'refs/heads/release/payments',
      upstreamRemote: 'upstream',
      upstreamUrl: 'https://github.com/parent/widget.git',
      prBranches: ['feat/payments'],
    },
  ];
  for (const { prBranches, ...options } of cases) {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-upstream-base-'));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const gh = makeGitGhExec({ ...options, openPr: openPaymentPr });
    const branches = [];
    const exec = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'pr') {
        branches.push(args[2]);
        if (args[2] === 'main') return bad('no pull requests found for branch "main"');
      }
      return gh.exec(cmd, args, opts);
    };
    const srv = makeAppServer({ pollSequence: [makeJob({ pr_url: openPaymentPr.url })] });
    const review = (argv) => runCli(argv, { exec, fetch: srv.fetch, stateDir });

    for (const argv of [['review'], ['review', '--runner', 'app']]) {
      const result = await review(argv);
      assert.equal(result.code, 0, result.text);
      assert.match(result.text, /Off-by-one in discount calculation/);
    }
    assert.deepEqual(branches, [...prBranches, ...prBranches]);
    assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
      { repo: 'acme/widget', tier: 'standard', pr: 42 },
    ]);
    assert.equal(loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDir }, repoKey: '/repo-app' }).prBaseSha, B);
  }
});

test('App repository lookup falls back to origin while keeping PR lookup and bookmark reuse', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-repo-fallback-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec({ repoLookupError: 'GraphQL: HTTP 502', openPr: openPaymentPr });
  const srv = makeAppServer({ pollSequence: [makeJob({ pr_url: openPaymentPr.url })] });

  for (const args of [['review'], ['review', '--runner', 'app'], ['review']]) {
    const result = await runCli(args, { exec: gh.exec, fetch: srv.fetch, stateDir });
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /Off-by-one in discount calculation/);
  }
  assert.equal(gh.calls.filter((c) => c.cmd === 'git' && c.args.join(' ') === 'remote get-url origin').length, 3);
  assert.equal(gh.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args.includes('github.com/acme/widget')).length, 3);
  assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
    { repo: 'acme/widget', tier: 'standard', pr: 42 },
  ]);

  const ghe = makeGitGhExec({ repoLookupError: 'GraphQL: HTTP 502', remoteUrl: 'git@ghe.example:acme/widget.git' });
  const enterpriseSrv = makeAppServer();
  const enterpriseResult = await runCli(['review'], { exec: ghe.exec, fetch: enterpriseSrv.fetch, stateDir });
  assert.equal(enterpriseResult.code, 4, enterpriseResult.text);
  assert.deepEqual(enterpriseSrv.requests, []);
});

test('App retains PR discovery on origin when gh auth status fails', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-auth-fallback-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec({ authError: 'HTTP 502 checking another GitHub host', openPr: openPaymentPr });
  const srv = makeAppServer({ pollSequence: [makeJob({ pr_url: openPaymentPr.url })] });
  const review = (argv, exec = gh.exec) => runCli(argv, { exec, fetch: srv.fetch, stateDir });

  assert.equal((await review(['review'])).code, 0);
  assert.equal((await review(['review', '--runner', 'app'])).code, 0);
  assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
    { repo: 'acme/widget', tier: 'standard', pr: 42 },
  ]);

  const outage = makeGitGhExec({ authError: 'HTTP 502', prLookupError: 'GraphQL: HTTP 502', workflowPresent: true });
  const requestCount = srv.requests.length;
  for (const argv of [['review'], ['review', '--runner', 'app']]) {
    const result = await review(argv, outage.exec);
    assert.equal(result.code, 4, result.text);
    assert.match(result.text, /Could not check whether branch feat\/payments has an open pull request on GitHub \(GraphQL: HTTP 502\)/);
    assert.match(result.text, /Nothing was started and no credit was used/);
  }
  assert.equal(srv.requests.length, requestCount, 'the outage must not read a bookmark or submit');
  assert.equal(outage.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'pr').length, 2);
  assert.equal(outage.calls.some((c) => c.cmd === 'gh' && c.args.some((a) => a.includes('/commits/'))), false);
  assert.equal(outage.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'workflow'), false);
});

test('an unsuccessful PR lookup on the origin fallback stops before a submission or saved result read', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-fallback-pr-error-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec({ repoLookupError: 'GraphQL: HTTP 502', prLookupError: 'GraphQL: HTTP 502', upstreamRef: 'refs/heads/release/payments' });
  const srv = makeAppServer();

  const review = (argv) => runCli(argv, { exec: gh.exec, fetch: srv.fetch, stateDir });
  const assertLookupError = (result) => {
    assert.equal(result.code, 4, result.text);
    assert.match(result.text, /Could not check whether branch release\/payments has an open pull request on GitHub \(GraphQL: HTTP 502\)/);
    assert.match(result.text, /Nothing was started and no credit was used/);
  };
  assertLookupError(await review(['review']));
  assertLookupError(await review(['review', '--runner', 'app']));

  assert.equal(saveLatestReview({
    env: { MEGALENS_STATE_DIR: stateDir }, repoKey: '/repo-app', id: `app:${JOB1}`,
    runner: 'app', nwo: 'acme/widget', headSha: H, prNumber: 42, prBaseSha: B, prBaseRef: 'main',
  }), true);
  assertLookupError(await review(['review']));
  assert.equal(gh.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'pr').length, 3);

  const branches = [];
  const exec = (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'pr') {
      branches.push(args[2]);
      if (args[2] === 'release/payments') return bad('no pull requests found for branch "release/payments"');
    }
    return gh.exec(cmd, args, opts);
  };
  const localLookupError = await runCli(['review'], { exec, fetch: srv.fetch, stateDir });
  assert.equal(localLookupError.code, 4, localLookupError.text);
  assert.match(localLookupError.text, /Could not check whether branch feat\/payments has an open pull request on GitHub \(GraphQL: HTTP 502\)/);
  assert.deepEqual(branches, ['release/payments', 'feat/payments']);
  assert.equal(srv.requests.some((r) => r.pathname.startsWith('/api/github-app/review-now')), false);
});

test('App requires a valid base SHA and refreshes a PR bookmark from an older plugin that omitted it', async (t) => {
  for (const runner of [[], ['--runner', 'app']]) {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-base-bookmark-'));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const env = { MEGALENS_STATE_DIR: stateDir };
    assert.equal(saveLatestReview({
      env, repoKey: '/repo-app', id: `app:${JOB2}`, runner: 'app', nwo: 'acme/widget',
      headSha: H, prNumber: 42, prBaseRef: 'main',
    }), true);
    const srv = makeAppServer({ pollSequence: [makeJob({ pr_url: openPaymentPr.url })] });

    for (const baseRefOid of [undefined, 'invalid']) {
      const gh = makeGitGhExec({ openPr: { ...openPaymentPr, baseRefOid } });
      const result = await runCli(['review', ...runner], { exec: gh.exec, fetch: srv.fetch, stateDir });
      assert.equal(result.code, 4, result.text);
      assert.match(result.text, /GitHub returned an invalid base commit for pull request #42/);
      assert.equal(srv.requests.some((r) => r.pathname.startsWith('/api/github-app/review-now')), false);
    }

    const gh = makeGitGhExec({ openPr: openPaymentPr });
    const run = () => runCli(['review', ...runner], { exec: gh.exec, fetch: srv.fetch, stateDir });
    const fresh = await run();
    assert.equal(fresh.code, 0, fresh.text);
    const reused = await run();
    assert.equal(reused.code, 0, reused.text);
    const bookmark = loadLatestReview({ env, repoKey: '/repo-app' });
    assert.equal(bookmark.id, `app:${JOB1}`);
    assert.equal(bookmark.prBaseSha, B);
    assert.deepEqual(srv.requests.filter((r) => r.method === 'POST').map((r) => r.body), [
      { repo: 'acme/widget', tier: 'standard', pr: 42 },
    ]);
    assert.equal(srv.requests.some((r) => r.pathname.endsWith(JOB2)), false);
  }
});

test('App not installed: falls back to dispatch workflow if present, else prints exact one-line setup URL', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-notinst-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const notInstalled = { installed: false, linked: false, notice_accepted: false, suspended: false };

  // 1. Not installed, NO workflow -> exact one-line setup message
  const ghNone = makeGitGhExec({ workflowPresent: false });
  const srvNone = makeAppServer({ statusResp: notInstalled });
  const rNone = await runCli(['review'], { exec: ghNone.exec, fetch: srvNone.fetch, stateDir });
  assert.equal(rNone.code, 4);
  assert.equal(rNone.text, `${SETUP_LINE}\n`);
  assert.equal(srvNone.requests.some((x) => x.method === 'POST'), false);

  // 2. Not installed, workflow present -> falls back to dispatch workflow
  const ghWf = makeGitGhExec({ workflowPresent: true });
  const srvWf = makeAppServer({ statusResp: notInstalled });
  // Provide artifact download for workflow completion
  const execWithDl = async (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'run' && args[1] === 'download') {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path.join(args[args.indexOf('-D') + 1], 'findings.json'), JSON.stringify(makeDoc()));
      return ok('');
    }
    return ghWf.exec(cmd, args, opts);
  };
  const rWf = await runCli(['review'], { exec: execWithDl, fetch: srvWf.fetch, stateDir });
  assert.equal(rWf.code, 0, rWf.text);
  assert.equal(ghWf.calls.some((c) => c.args[0] === 'workflow' && c.args[1] === 'run'), true);
  assert.equal(srvWf.requests.some((x) => x.method === 'POST'), false);

  // 3. Server 404 on /status (flag off / test-only) and no workflow -> exact one-line setup message
  const srv404 = makeAppServer({ statusHttp: 404, statusResp: { error: 'not_found' } });
  const r404 = await runCli(['review'], { exec: ghNone.exec, fetch: srv404.fetch, stateDir });
  assert.equal(r404.code, 4);
  assert.equal(r404.text, `${SETUP_LINE}\n`);
});

test('Out of credits: reported plainly as NOT COMPLETED with billing link and never called clean', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-credits-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec();
  const srv = makeAppServer({
    pollSequence: [
      makeJob({ status: 'queued', result_status: null, findings: null }),
      makeJob({ status: 'no_credits', reason: 'insufficient_credits', result_status: null, findings: null }),
    ],
  });

  const r = await runCli(['review'], { exec: gh.exec, fetch: srv.fetch, stateDir, timing: { pollMs: 1 } });
  assert.equal(r.code, 4);
  assert.match(r.text, /NOT COMPLETED/);
  assert.match(r.text, /out of credits/i);
  assert.ok(r.text.includes(APP_BILLING_URL));
  assert.match(r.text, /not a clean review/);
  assert.equal(/No findings were reported/.test(r.text), false);
});

test('Review failed, cancelled, skipped, partial, too_large, stale, and 24h expired are never called clean', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-fail-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cases = [
    { job: makeJob({ status: 'failed', reason: 'worker_lost', result_status: null, findings: null }), code: 4, match: /FAILED[\s\S]*review machine stopped[\s\S]*not a clean review/i },
    { job: makeJob({ status: 'failed', reason: 'timeout', result_status: null, findings: null }), code: 4, match: /FAILED[\s\S]*ran out of time[\s\S]*not a clean review/i },
    { job: makeJob({ status: 'cancelled', reason: 'superseded', result_status: null, findings: null }), code: 4, match: /CANCELLED[\s\S]*newer commit superseded[\s\S]*not a clean review/i },
    { job: makeJob({ status: 'skipped', reason: 'stale_head', result_status: null, findings: null }), code: 4, match: /NOT COMPLETED[\s\S]*pull request changed[\s\S]*not a clean review/i },
    { job: makeJob({ status: 'done', result_status: 'too_large', findings: null }), code: 4, match: /NOT COMPLETED[\s\S]*too large[\s\S]*not a clean review/i },
    { job: makeJob({ status: 'done', result_status: 'stale', findings: null }), code: 4, match: /NOT COMPLETED[\s\S]*pull request changed[\s\S]*not a clean review/i },
    { job: makeJob({ status: 'done', result_status: 'complete', findings: null }), code: 4, match: /RESULT EXPIRED[\s\S]*24 hours/i },
    {
      job: makeJob({
        status: 'done',
        result_status: 'partial',
        findings: makeDoc({ status: 'partial', passes: [{ name: 'a', status: 'ok' }, { name: 'b', status: 'failed', reason: 'timeout' }] }),
      }),
      code: 2,
      match: /PARTIAL[\s\S]*does not mean the change is clean/i,
    },
  ];
  for (const c of cases) {
    const srv = makeAppServer({ pollSequence: [c.job] });
    const res = await appResult({ env: { MEGALENS_TOKEN: TOKEN }, fetch: srv.fetch }, `app:${JOB1}`, { showId: false });
    assert.equal(res.code, c.code, `unexpected code for ${c.job.status}/${c.job.result_status}/${c.job.reason}`);
    assert.match(res.text, c.match);
    assert.equal(/No findings were reported by a complete review/.test(res.text), false);
  }
});

test('Timeout (20-min cap) + resume via /megalens:status, /megalens:result, and re-running /megalens:review (no second POST)', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-timeout-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const clk = fakeClock();
  const gh = makeGitGhExec();
  let finished = false;
  const srv = makeAppServer({
    pollHandler: () => jsonResp(200, finished ? makeJob() : makeJob({ status: 'running', result_status: null, findings: null })),
  });

  // 1. First /megalens:review hits the 20-minute cap
  const r1 = await runCli(['review'], { exec: gh.exec, fetch: srv.fetch, stateDir, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r1.code, 0);
  assert.equal(clk.sleeps.reduce((a, b) => a + b, 0), DEFAULT_WAIT_MS);
  assert.ok(r1.text.includes(STILL_RUNNING_LINE));
  assert.equal(r1.text.includes(JOB1), false);
  assert.equal(srv.requests.filter((x) => x.method === 'POST').length, 1);

  // 2. /megalens:status (no id) while still running -> still running, no id
  const st = await runCli(['status'], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(st.code, 0);
  assert.equal(st.text, `${STILL_RUNNING_LINE}\n`);
  assert.equal(st.text.includes(JOB1), false);

  // 3. /megalens:result (no id) while still running -> exit 4, still running
  const resStill = await runCli(['result'], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(resStill.code, 4);
  assert.equal(resStill.text, `${STILL_RUNNING_LINE}\n`);

  // 4. Re-running /megalens:review while still running reuses the in-flight job via GET with ZERO second POST
  let pollsOnResume = 0;
  const srvResume = makeAppServer({
    pollHandler: () => {
      pollsOnResume += 1;
      return jsonResp(200, pollsOnResume >= 2 ? makeJob() : makeJob({ status: 'running', result_status: null, findings: null }));
    },
  });
  const rResume = await runCli(['review'], { exec: gh.exec, fetch: srvResume.fetch, stateDir, timing: { pollMs: 1 } });
  assert.equal(rResume.code, 0, rResume.text);
  assert.equal(srvResume.requests.filter((x) => x.method === 'POST').length, 0, 'must reuse in-flight bookmarked job without POST');
  assert.match(rResume.text, /Resuming in-flight review/);
  assert.ok(rResume.text.includes(`${COMMIT_SCOPE}\n\n## MegaLens standard review: complete`), rResume.text);
  assert.match(rResume.text, /## MegaLens standard review: complete/);
  assert.match(rResume.text, /Off-by-one in discount calculation/);
  assert.equal(rResume.text.includes(JOB1), false);

  // 5. Once finished, /megalens:result (no id) returns findings inline with no id, and explicit app:<uuid> includes links
  finished = true;
  const resDone = await runCli(['result'], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(resDone.code, 0);
  assert.match(resDone.text, /Off-by-one in discount calculation/);
  assert.equal(resDone.text.includes(JOB1), false);

  const resExplicit = await runCli(['result', `app:${JOB1}`], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(resExplicit.code, 0);
  assert.match(resExplicit.text, new RegExp(`Review id: app:${JOB1}`));
  assert.match(resExplicit.text, /Check: https:\/\/github\.com\/acme\/widget\/runs\/777/);
});

test('One charge per review: lost POST reply retries once and reuses server deduplicated job_id', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-lost-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const clk = fakeClock();
  const gh = makeGitGhExec();

  // Attempt 1 reaches server (creates JOB1) then reply is lost (503 / network drop).
  // Attempt 2 sends identical payload -> server deduplicates and returns 202 with same JOB1.
  let posts = 0;
  let serverJobsCreated = 0;
  const srv = makeAppServer({
    submitHandler: () => {
      posts += 1;
      if (posts === 1) {
        serverJobsCreated = 1;
        throw new Error('socket hang up');
      }
      const statusUrl = `/api/github-app/review-now/${JOB1}`;
      return jsonResp(202, { job_id: JOB1, status_url: statusUrl }, { location: statusUrl });
    },
    pollSequence: [makeJob()],
  });

  const r = await runCli(['review'], { exec: gh.exec, fetch: srv.fetch, stateDir, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r.code, 0, r.text);
  assert.equal(posts, 2, 'retries POST once after lost reply');
  assert.equal(serverJobsCreated, 1, 'server created only one job');
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.equal(loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDir }, repoKey: '/repo-app' })?.id, `app:${JOB1}`);

  // If BOTH POST attempts lose the reply -> stops after 2 attempts and warns cleanly (never loops)
  let badPosts = 0;
  const srvDown = makeAppServer({
    submitHandler: () => {
      badPosts += 1;
      return jsonResp(503, { error: 'unavailable' }, { 'retry-after': '1' });
    },
  });
  const stateDir2 = mkdtempSync(path.join(tmpdir(), 'mlapp-lost2-'));
  t.after(() => rmSync(stateDir2, { recursive: true, force: true }));
  const rDown = await runCli(['review'], { exec: gh.exec, fetch: srvDown.fetch, stateDir: stateDir2, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(rDown.code, 4);
  assert.equal(badPosts, 2);
  assert.match(rDown.text, /Could not confirm whether MegaLens started the review/);
  assert.match(rDown.text, /reuses an in-flight review/i);

  // 409 review_finishing must NOT auto-retry and must direct the user to GitHub without inviting a rerun
  let finishPosts = 0;
  const srvFinishing = makeAppServer({
    submitHandler: () => {
      finishPosts += 1;
      return jsonResp(409, { error: 'review_finishing' }, { 'retry-after': '2' });
    },
  });
  const rFin = await runCli(['review'], { exec: gh.exec, fetch: srvFinishing.fetch, stateDir: stateDir2, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(rFin.code, 4);
  assert.equal(finishPosts, 1);
  assert.match(rFin.text, /already finishing on GitHub/i);
  assert.match(rFin.text, new RegExp(`https://github\\.com/acme/widget/commit/${H}`));
  assert.match(rFin.text, /do not run \/megalens:review again/i);
  assert.equal(/or run \/megalens:review again in a moment/i.test(rFin.text), false);
});

test('Submit errors (429 daily_cap, 409 suspended/notice_required, 401 unauthorized, 422 target_unavailable) report plain messages', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-errs-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec();
  const clk = fakeClock();
  const cases = [
    [429, { error: 'daily_cap' }, { 'retry-after': '3600' }, /daily MegaLens App review limit.*1 hour/i],
    [409, { error: 'installation_suspended' }, {}, /suspended on GitHub/i],
    [409, { error: 'notice_required' }, {}, /accept the review notice/i],
    [401, { error: 'unauthorized' }, {}, /sign-in token was rejected/i],
    [422, { error: 'target_unavailable' }, {}, /cannot review this target/i],
  ];
  for (const [status, body, headers, match] of cases) {
    let postCount = 0;
    const srv = makeAppServer({
      submitHandler: () => { postCount += 1; return jsonResp(status, body, headers); },
    });
    const r = await runCli(['review', '--runner', 'app'], { exec: gh.exec, fetch: srv.fetch, stateDir, timing: { now: clk.now, sleep: clk.sleep } });
    assert.equal(r.code, 4);
    assert.equal(postCount, 1, `should not retry ${status} ${body.error}`);
    assert.match(r.text, match);
  }
});

test('Token & URL security: origin pinned to https://megalens.ai (ignores env overrides), refuses redirects, scrubs token everywhere', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-sec-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  // Finding 1: Production App client is pinned to https://megalens.ai regardless of MEGALENS_API_URL or MEGALENS_URL
  for (const overrideEnv of [
    {},
    { MEGALENS_API_URL: 'https://attacker.example/api' },
    { MEGALENS_URL: 'https://attacker.example/api/mcp' },
    { MEGALENS_API_URL: 'http://127.0.0.1:3000/api/v2' },
    { MEGALENS_API_URL: 'http://evil.example/api' },
    { MEGALENS_API_URL: 'https://user:pass@megalens.ai' },
  ]) {
    assert.equal(resolveAppApiBase(overrideEnv).origin, 'https://megalens.ai');
  }

  // End-to-end review with project-injected MEGALENS_API_URL / MEGALENS_URL sends ZERO requests to attacker host
  const gh = makeGitGhExec();
  const seenUrls = [];
  const srv = makeAppServer();
  const spyFetch = async (url, init) => {
    seenUrls.push(String(url));
    return srv.fetch(url, init);
  };
  const rPinned = await runCli(['review'], {
    exec: gh.exec,
    fetch: spyFetch,
    stateDir,
    env: { MEGALENS_API_URL: 'https://attacker.example', MEGALENS_URL: 'https://attacker.example/api/mcp' },
  });
  assert.equal(rPinned.code, 0, rPinned.text);
  assert.ok(seenUrls.length >= 3);
  for (const u of seenUrls) {
    assert.equal(new URL(u).origin, 'https://megalens.ai', `token must never be sent to ${u}`);
  }

  // 302 redirect is refused without leaking token
  const stRedir = await checkAppStatus({
    env: { MEGALENS_TOKEN: TOKEN },
    nwo: 'acme/widget',
    fetch: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response('', { status: 302, headers: { location: 'https://attacker.example/' } });
    },
  });
  assert.equal(stRedir.state, 'error');
  assert.match(stRedir.error, /redirect/i);

  // Token echoed in findings, reason, or malicious URL is scrubbed and non-GitHub URLs are dropped
  const leakyJob = makeJob({
    pr_url: 'https://evil.example/pull/1',
    check_url: 'https://github.com/acme/widget/runs/777',
    findings: makeDoc({
      findings: [{
        id: 'f1',
        file: 'a.js',
        line_start: 1,
        title: `Leaked ${TOKEN} and Bearer secretvalue1234567890`,
        claim: `Also ml_tok_${'a'.repeat(32)}`,
        priority: 'P1',
        strength: 'strong',
        found_by: ['codex-standard'],
      }],
    }),
  });
  const srvLeaky = makeAppServer({ pollSequence: [leakyJob] });
  const rLeaky = await appResult({ env: { MEGALENS_TOKEN: TOKEN }, fetch: srvLeaky.fetch }, `app:${JOB1}`, { showId: true });
  assert.equal(rLeaky.code, 0);
  assert.equal(rLeaky.text.includes(TOKEN), false);
  assert.equal(rLeaky.text.includes('secretvalue1234567890'), false);
  assert.equal(rLeaky.text.includes('a'.repeat(32)), false);
  assert.equal(rLeaky.text.includes('evil.example'), false);
  assert.match(rLeaky.text, /Check: https:\/\/github\.com\/acme\/widget\/runs\/777/);
});

test('Finding 9: retryable polling respects Retry-After: 60 within 20-min cap, keeps waiting across transient errors, and hides internal IDs in no-flag output', async (t) => {
  const gh = makeGitGhExec();

  // 1. 429 rate_limited with Retry-After: 60 waits full 60s (NOT 5s) and recovers cleanly within 20-min budget
  const stateDir1 = mkdtempSync(path.join(tmpdir(), 'mlapp-poll429-'));
  t.after(() => rmSync(stateDir1, { recursive: true, force: true }));
  const clk1 = fakeClock();
  let polls1 = 0;
  const srv1 = makeAppServer({
    pollHandler: () => {
      polls1 += 1;
      if (polls1 <= 2) return jsonResp(429, { error: 'rate_limited' }, { 'retry-after': '60' });
      return jsonResp(200, makeJob());
    },
  });
  const r1 = await runCli(['review'], { exec: gh.exec, fetch: srv1.fetch, stateDir: stateDir1, timing: { now: clk1.now, sleep: clk1.sleep } });
  assert.equal(r1.code, 0, r1.text);
  assert.equal(srv1.requests.filter((x) => x.method === 'POST').length, 1);
  assert.equal(polls1, 3);
  assert.deepEqual(clk1.sleeps, [60_000, 60_000], 'must honour Retry-After: 60 instead of clamping to 5s');
  assert.match(r1.text, /Off-by-one in discount calculation/);
  assert.equal(r1.text.includes(JOB1), false);

  // 2. Multiple consecutive 502s keep waiting with backoff and recover cleanly when API returns
  const stateDir2 = mkdtempSync(path.join(tmpdir(), 'mlapp-poll502-'));
  t.after(() => rmSync(stateDir2, { recursive: true, force: true }));
  const clk2 = fakeClock();
  let polls2 = 0;
  const srv2 = makeAppServer({
    pollHandler: () => (++polls2 <= 4 ? jsonResp(502, { error: 'bad_gateway' }) : jsonResp(200, makeJob())),
  });
  const r2 = await runCli(['review'], { exec: gh.exec, fetch: srv2.fetch, stateDir: stateDir2, timing: { now: clk2.now, sleep: clk2.sleep } });
  assert.equal(r2.code, 0, r2.text);
  assert.equal(polls2, 5);
  assert.equal(r2.text.includes(JOB1), false);

  // 3. Persistent 502s wait through the full 20-min cap, keep bookmark, emit STILL_RUNNING_LINE, and hide UUID
  const stateDir3 = mkdtempSync(path.join(tmpdir(), 'mlapp-pollcap-'));
  t.after(() => rmSync(stateDir3, { recursive: true, force: true }));
  const clk3 = fakeClock();
  const srv3 = makeAppServer({ pollHandler: () => jsonResp(502, { error: 'bad_gateway' }) });
  const r3 = await runCli(['review'], { exec: gh.exec, fetch: srv3.fetch, stateDir: stateDir3, timing: { now: clk3.now, sleep: clk3.sleep } });
  assert.equal(r3.code, 0);
  assert.equal(clk3.sleeps.reduce((a, b) => a + b, 0), DEFAULT_WAIT_MS);
  assert.ok(r3.text.includes(STILL_RUNNING_LINE));
  assert.equal(r3.text.includes(JOB1), false, 'must not expose App UUID on capped transient polling');
  assert.equal(loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDir3 }, repoKey: '/repo-app' })?.id, `app:${JOB1}`);

  // 4. Permanent 404 poll error stops immediately in no-flag mode without exposing App UUID
  const stateDir4 = mkdtempSync(path.join(tmpdir(), 'mlapp-poll404-'));
  t.after(() => rmSync(stateDir4, { recursive: true, force: true }));
  const srv404 = makeAppServer({ pollHandler: () => jsonResp(404, { error: 'not_found' }) });
  const r404 = await runCli(['review'], { exec: gh.exec, fetch: srv404.fetch, stateDir: stateDir4, timing: { pollMs: 1 } });
  assert.equal(r404.code, 4);
  assert.equal(r404.text.includes(JOB1), false, 'no-flag poll error must not expose App UUID');

  // 5. Ordinary failed results (with or without findings doc, including publish_failed) hide app: and rv_ IDs in no-flag mode,
  //    while explicit /megalens:result app:<uuid> keeps them for diagnostics
  for (const failedJob of [
    makeJob({ status: 'failed', reason: 'worker_lost', result_status: null, findings: null }),
    makeJob({ status: 'failed', reason: 'publish_failed', result_status: null, findings: null }),
    makeJob({ status: 'failed', reason: 'review_failed', result_status: 'failed', findings: makeDoc({ status: 'failed', passes: [{ name: 'codex-standard', status: 'failed', reason: 'crash' }] }) }),
  ]) {
    const srvF = makeAppServer({ pollSequence: [failedJob, failedJob] });
    const noFlag = await appResult({ env: { MEGALENS_TOKEN: TOKEN }, fetch: srvF.fetch }, `app:${JOB1}`, { showId: false });
    assert.equal(noFlag.code, 4);
    assert.match(noFlag.text, /FAILED/);
    assert.equal(noFlag.text.includes(JOB1), false, `no-flag failed output must hide app UUID for ${failedJob.reason}`);
    assert.equal(noFlag.text.includes('rv_app12345'), false, `no-flag failed output must hide rv_ id for ${failedJob.reason}`);
    if (failedJob.reason === 'publish_failed') {
      assert.match(noFlag.text, /could not publish/i);
      assert.equal(/nothing more was charged/i.test(noFlag.text), false);
    }
    const explicit = await appResult({ env: { MEGALENS_TOKEN: TOKEN }, fetch: srvF.fetch }, `app:${JOB1}`, { showId: true });
    assert.equal(explicit.code, 4);
    assert.match(explicit.text, new RegExp(`Review id: app:${JOB1}`));
  }

  // 6. Bookmark for different commit/tier does NOT reuse old job
  saveLatestReview({ env: { MEGALENS_STATE_DIR: stateDir3 }, repoKey: '/repo-app', id: `app:${JOB2}`, runner: 'app', nwo: 'acme/widget', tier: 'deep', headSha: H });
  const srvNew = makeAppServer({ pollSequence: [makeJob({ tier: 'standard' })] });
  const rStd = await runCli(['review'], { exec: gh.exec, fetch: srvNew.fetch, stateDir: stateDir3 });
  assert.equal(rStd.code, 0);
  assert.equal(srvNew.requests.filter((x) => x.method === 'POST').length, 1, 'different tier must submit fresh job');
});

test('Finding 2: lost PR reply never retries into a second billable job, and PR head drift rejects wrong-head result and fixes bookmark', async (t) => {
  const H2 = 'c'.repeat(40);
  const openPr = {
    number: 42,
    state: 'OPEN',
    isDraft: false,
    headRefOid: H,
    baseRefOid: B,
    isCrossRepository: false,
    url: 'https://github.com/acme/widget/pull/42',
  };

  // 2a. Lost PR reply (network drop / 503): stops after 1 POST (even if teammate pushes H2) and points to PR on GitHub
  const stateDir1 = mkdtempSync(path.join(tmpdir(), 'mlapp-prlost-'));
  t.after(() => rmSync(stateDir1, { recursive: true, force: true }));
  const gh1 = makeGitGhExec({ openPr });
  let prPosts = 0;
  const srvPrLost = makeAppServer({
    submitHandler: () => {
      prPosts += 1;
      throw new Error('socket hang up');
    },
  });
  const rLost = await runCli(['review'], { exec: gh1.exec, fetch: srvPrLost.fetch, stateDir: stateDir1 });
  assert.equal(rLost.code, 4);
  assert.equal(prPosts, 1, 'must NEVER retry a mutable PR submission after a lost reply');
  assert.match(rLost.text, /do NOT start another one/i);
  assert.match(rLost.text, /https:\/\/github\.com\/acme\/widget\/pull\/42/);

  // 2b. PR head drift between preflight and server resolution: server returns JOB2 for H2;
  //     CLI must NOT render H2 findings as a review of H1 and must bookmark JOB2 under H2 (not H1)
  const stateDir2 = mkdtempSync(path.join(tmpdir(), 'mlapp-prdrift-'));
  t.after(() => rmSync(stateDir2, { recursive: true, force: true }));
  const gh2 = makeGitGhExec({ openPr });
  const srvDrift = makeAppServer({
    submitHandler: () => jsonResp(202, { job_id: JOB2, status_url: `/api/github-app/review-now/${JOB2}` }),
    pollSequence: [makeJob({ job_id: JOB2, head_sha: H2, pr_url: 'https://github.com/acme/widget/pull/42' })],
  });
  const rDrift = await runCli(['review'], { exec: gh2.exec, fetch: srvDrift.fetch, stateDir: stateDir2 });
  assert.equal(rDrift.code, 4);
  assert.match(rDrift.text, /NOT COMPLETED/);
  assert.match(rDrift.text, /Pull request #42 on GitHub moved to commit ccccccc/);
  assert.equal(rDrift.text.includes('Off-by-one in discount calculation'), false, 'must never render wrong-head findings');
  const savedAfterDrift = loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDir2 }, repoKey: '/repo-app' });
  assert.equal(savedAfterDrift?.id, `app:${JOB2}`);
  assert.equal(savedAfterDrift?.headSha, H2, 'bookmark must record actual server head_sha, not stale local SHA');

  // 2c. 409 review_finishing on PR directs user to the PR URL and warns against rerunning
  const srvFinPr = makeAppServer({
    submitHandler: () => jsonResp(409, { error: 'review_finishing' }, { 'retry-after': '2' }),
  });
  const stateDir3 = mkdtempSync(path.join(tmpdir(), 'mlapp-prfin-'));
  t.after(() => rmSync(stateDir3, { recursive: true, force: true }));
  const rFinPr = await runCli(['review'], { exec: gh2.exec, fetch: srvFinPr.fetch, stateDir: stateDir3 });
  assert.equal(rFinPr.code, 4);
  assert.match(rFinPr.text, /https:\/\/github\.com\/acme\/widget\/pull\/42/);
  assert.match(rFinPr.text, /do not run \/megalens:review again/i);
});

test('Finding 3: App status 503 outage resumes matching App bookmark and never falls back to dispatch Actions', async (t) => {
  // 3a. Both App and workflow configured: start App job -> cap -> rerun while /status returns 503.
  //     Must read and resume JOB1 directly without touching Actions!
  const stateDir1 = mkdtempSync(path.join(tmpdir(), 'mlapp-outage-resume-'));
  t.after(() => rmSync(stateDir1, { recursive: true, force: true }));
  const clk = fakeClock();
  const gh1 = makeGitGhExec({ workflowPresent: true });
  const srvStart = makeAppServer({
    pollHandler: () => jsonResp(200, makeJob({ status: 'running', result_status: null, findings: null })),
  });
  const r1 = await runCli(['review'], { exec: gh1.exec, fetch: srvStart.fetch, stateDir: stateDir1, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r1.code, 0);
  assert.ok(r1.text.includes(STILL_RUNNING_LINE));

  const gh2 = makeGitGhExec({ workflowPresent: true });
  let reads = 0;
  const srvOutage = makeAppServer({
    statusHttp: 503,
    statusResp: { error: 'unavailable' },
    pollHandler: () => {
      reads += 1;
      return jsonResp(200, reads === 1 ? makeJob({ status: 'running', result_status: null, findings: null }) : makeJob());
    },
  });
  const r2 = await runCli(['review'], { exec: gh2.exec, fetch: srvOutage.fetch, stateDir: stateDir1, timing: { pollMs: 1 } });
  assert.equal(r2.code, 0, r2.text);
  assert.ok(reads >= 2, 'must read the saved App job directly before runner selection');
  assert.equal(srvOutage.requests.some((x) => x.method === 'POST'), false, 'zero second POST');
  assert.equal(gh2.calls.some((c) => c.args[0] === 'workflow'), false, 'must NEVER dispatch Actions during App status 503');
  assert.match(r2.text, /Off-by-one in discount calculation/);

  // 3b. Both App and workflow configured, NO bookmark yet, /status returns 503 -> stops cleanly, ZERO workflow dispatch
  const stateDir2 = mkdtempSync(path.join(tmpdir(), 'mlapp-outage-fresh-'));
  t.after(() => rmSync(stateDir2, { recursive: true, force: true }));
  const gh3 = makeGitGhExec({ workflowPresent: true });
  const srv503 = makeAppServer({ statusHttp: 503, statusResp: { error: 'unavailable' } });
  const r3 = await runCli(['review'], { exec: gh3.exec, fetch: srv503.fetch, stateDir: stateDir2 });
  assert.equal(r3.code, 4);
  assert.match(r3.text, /Could not reach MegaLens to check GitHub App status/);
  assert.equal(gh3.calls.some((c) => c.args[0] === 'workflow'), false, 'transient 503 is not a definitive fallback signal');

  // 3c. Matching App bookmark exists AND GET /review-now/<id> returns 503 -> waits across retryable reads up to cap,
  //     ZERO workflow dispatch, ZERO second POST, and hides UUID; non-retryable 401 stops immediately with exit 4 & zero Actions
  const clk4 = fakeClock();
  const gh4 = makeGitGhExec({ workflowPresent: true });
  const srvJob503 = makeAppServer({
    statusHttp: 503,
    statusResp: { error: 'unavailable' },
    pollHandler: () => jsonResp(503, { error: 'unavailable' }),
  });
  const r4 = await runCli(['review'], { exec: gh4.exec, fetch: srvJob503.fetch, stateDir: stateDir1, timing: { now: clk4.now, sleep: clk4.sleep } });
  assert.equal(r4.code, 0);
  assert.equal(clk4.sleeps.reduce((a, b) => a + b, 0), DEFAULT_WAIT_MS);
  assert.ok(r4.text.includes(STILL_RUNNING_LINE));
  assert.equal(gh4.calls.some((c) => c.args[0] === 'workflow'), false);
  assert.equal(srvJob503.requests.some((x) => x.method === 'POST'), false);
  assert.equal(r4.text.includes(JOB1), false);

  const gh5 = makeGitGhExec({ workflowPresent: true });
  const srvJob401 = makeAppServer({
    statusHttp: 503,
    statusResp: { error: 'unavailable' },
    pollHandler: () => jsonResp(401, { error: 'unauthorized' }),
  });
  const r5 = await runCli(['review'], { exec: gh5.exec, fetch: srvJob401.fetch, stateDir: stateDir1 });
  assert.equal(r5.code, 4);
  assert.equal(gh5.calls.some((c) => c.args[0] === 'workflow'), false);
  assert.equal(srvJob401.requests.some((x) => x.method === 'POST'), false);
  assert.equal(r5.text.includes(JOB1), false);
});

test('Finding 5: browser sign-in credential in user ~/.claude.json connects /megalens:review with empty shell env', async (t) => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'mlapp-claude-home-'));
  const customCfgDir = mkdtempSync(path.join(tmpdir(), 'mlapp-claude-cfg-'));
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(customCfgDir, { recursive: true, force: true });
  });
  const browserTok = 'ml_tok_' + 'a'.repeat(32);
  writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
    mcpServers: {
      megalens: {
        type: 'http',
        url: 'https://megalens.ai/api/mcp?ide=claude-code',
        headers: { Authorization: `Bearer ${browserTok}` },
      },
    },
  }), { mode: 0o600 });

  // Empty shell env (no MEGALENS_TOKEN!) -> discovers browser sign-in token and runs App review
  const gh = makeGitGhExec({ workflowPresent: true });
  const srv = makeAppServer();
  const r = await runCli(['review'], {
    exec: gh.exec,
    fetch: srv.fetch,
    stateDir: homeDir,
    env: { HOME: homeDir, MEGALENS_TOKEN: undefined },
  });
  assert.equal(r.code, 0, r.text);
  assert.equal(srv.requests[0].headers.Authorization, `Bearer ${browserTok}`);
  assert.equal(gh.calls.some((c) => c.args[0] === 'workflow'), false);
  assert.equal(r.text.includes(browserTok), false);
  for (const c of gh.calls) assert.equal(Object.values(c.env ?? {}).includes(browserTok), false);

  // CLAUDE_CONFIG_DIR override works too
  const customTok = 'ml_tok_' + 'b'.repeat(32);
  writeFileSync(path.join(customCfgDir, '.claude.json'), JSON.stringify({
    mcpServers: {
      megalens: {
        type: 'http',
        url: 'https://megalens.ai/api/mcp?ide=claude-code',
        headers: { authorization: `Bearer ${customTok}` },
      },
    },
  }), { mode: 0o600 });
  assert.equal(extractAppToken({ HOME: homeDir, CLAUDE_CONFIG_DIR: customCfgDir }), customTok);
  // Relative CLAUDE_CONFIG_DIR resolves via path.resolve(), matching @megalens/mcp browser setup
  const relCfgDir = path.relative(process.cwd(), customCfgDir);
  assert.equal(
    resolveClaudeMcpConfigPath({ HOME: homeDir, CLAUDE_CONFIG_DIR: './claude-profile' }),
    path.join(path.resolve('./claude-profile'), '.claude.json'),
  );
  assert.equal(extractAppToken({ HOME: homeDir, CLAUDE_CONFIG_DIR: relCfgDir }), customTok);
  // End-to-end review with relative CLAUDE_CONFIG_DIR and empty shell env uses the browser sign-in token
  const srvRel = makeAppServer();
  const rRel = await runCli(['review'], {
    exec: makeGitGhExec({ workflowPresent: true }).exec,
    fetch: srvRel.fetch,
    stateDir: customCfgDir,
    env: { HOME: homeDir, CLAUDE_CONFIG_DIR: relCfgDir, MEGALENS_TOKEN: undefined },
  });
  assert.equal(rRel.code, 0, rRel.text);
  assert.equal(srvRel.requests[0].headers.Authorization, `Bearer ${customTok}`);
  // Explicit env MEGALENS_TOKEN takes precedence
  assert.equal(extractAppToken({ HOME: homeDir, MEGALENS_TOKEN: TOKEN }), TOKEN);

  // Foreign MCP URL in .claude.json is rejected (never extracts token for a non-megalens.ai server)
  const foreignDir = mkdtempSync(path.join(tmpdir(), 'mlapp-foreign-'));
  t.after(() => rmSync(foreignDir, { recursive: true, force: true }));
  writeFileSync(path.join(foreignDir, '.claude.json'), JSON.stringify({
    mcpServers: {
      megalens: {
        type: 'http',
        url: 'https://evil.example/api/mcp',
        headers: { Authorization: `Bearer ${browserTok}` },
      },
    },
  }), { mode: 0o600 });
  assert.equal(extractAppToken({ HOME: foreignDir }), '');
});

test('Finding 6: confirmed missing App setup without gh prints the App-or-workflow setup line (not gh install error)', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-nogh-unlinked-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec({ hasGh: false, remoteUrl: 'git@github.com:acme/widget.git' });
  const srv = makeAppServer({
    statusResp: { installed: false, linked: false, notice_accepted: false, suspended: false },
  });
  const r = await runCli(['review'], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(r.code, 4);
  assert.equal(r.text, `${SETUP_LINE}\n`);
  assert.equal(r.text.includes('cli.github.com'), false);
});

test('Finding 7: GitHub Enterprise never selects the github.com App and PR discovery is bound to github.com/<nwo>', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-ghe-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  // 7a. Enterprise URL + no workflow -> ZERO App API calls, clear GHE message
  const ghGheNoWf = makeGitGhExec({ repoUrl: 'https://ghe.corp.example/acme/widget', workflowPresent: false });
  const srvGhe = makeAppServer();
  const rNoWf = await runCli(['review'], { exec: ghGheNoWf.exec, fetch: srvGhe.fetch, stateDir });
  assert.equal(rNoWf.code, 4);
  assert.equal(srvGhe.requests.length, 0, 'Enterprise repo must NEVER call github.com App API');
  assert.match(rNoWf.text, /github\.com/i);
  assert.match(rNoWf.text, /ghe\.corp\.example/);

  // 7b. Enterprise URL + workflow present -> uses GitHub Actions workflow, ZERO App API calls
  const ghGheWf = makeGitGhExec({ repoUrl: 'https://ghe.corp.example/acme/widget', workflowPresent: true });
  const execGheDl = async (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'run' && args[1] === 'download') {
      writeFileSync(path.join(args[args.indexOf('-D') + 1], 'findings.json'), JSON.stringify(makeDoc()));
      return ok('');
    }
    return ghGheWf.exec(cmd, args, opts);
  };
  const rWf = await runCli(['review'], { exec: execGheDl, fetch: srvGhe.fetch, stateDir });
  assert.equal(rWf.code, 0, rWf.text);
  assert.equal(srvGhe.requests.length, 0);
  assert.equal(ghGheWf.calls.some((c) => c.args[0] === 'workflow' && c.args[1] === 'run'), true);

  // 7c. Explicit --runner app on Enterprise repo -> refused before any App API call
  const rForced = await runCli(['review', '--runner', 'app'], { exec: ghGheNoWf.exec, fetch: srvGhe.fetch, stateDir });
  assert.equal(rForced.code, 4);
  assert.equal(srvGhe.requests.length, 0);
  assert.match(rForced.text, /github\.com/i);

  // 7d. PR discovery rejects a PR URL from another repo or Enterprise host and falls back to commit ref
  for (const wrongPrUrl of ['https://github.com/upstream/widget/pull/42', 'https://ghe.corp.example/acme/widget/pull/42']) {
    const dirPr = mkdtempSync(path.join(tmpdir(), 'mlapp-prbind-'));
    t.after(() => rmSync(dirPr, { recursive: true, force: true }));
    const ghWrongPr = makeGitGhExec({
      openPr: { number: 42, state: 'OPEN', isDraft: false, headRefOid: H, isCrossRepository: false, url: wrongPrUrl },
    });
    const srvPr = makeAppServer();
    const rPr = await runCli(['review'], { exec: ghWrongPr.exec, fetch: srvPr.fetch, stateDir: dirPr });
    assert.equal(rPr.code, 0, rPr.text);
    const post = srvPr.requests.find((x) => x.method === 'POST');
    assert.deepEqual(post.body, { repo: 'acme/widget', tier: 'standard', ref: H }, `must reject PR URL ${wrongPrUrl}`);
  }
});

test('Finding 8: unwritable/symlinked state dir stops before POST, and post-acceptance save failure gives explicit ID recovery path', async (t) => {
  const gh = makeGitGhExec();

  // 8a. Symlinked plugin-state dir stops BEFORE submitting any billable POST
  const trapDir = mkdtempSync(path.join(tmpdir(), 'mlapp-trap-'));
  const targetDir = mkdtempSync(path.join(tmpdir(), 'mlapp-target-'));
  t.after(() => {
    rmSync(trapDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
  symlinkSync(targetDir, path.join(trapDir, 'plugin-state'));
  assert.equal(canSaveLatestReview({ env: { MEGALENS_STATE_DIR: trapDir }, repoKey: '/repo-app' }), false);

  const srvPre = makeAppServer();
  const rPre = await runCli(['review'], { exec: gh.exec, fetch: srvPre.fetch, stateDir: trapDir });
  assert.equal(rPre.code, 4);
  assert.equal(srvPre.requests.some((x) => x.method === 'POST'), false, 'must NOT POST when bookmark cannot be saved');
  assert.match(rPre.text, /Cannot save the local review bookmark.*Nothing was started/i);

  // 8b. MEGALENS_STATE_DIR pointing to an existing regular file also stops before POST
  const badStateFile = path.join(targetDir, 'not-a-dir');
  writeFileSync(badStateFile, 'nope');
  const srvFile = makeAppServer();
  const rFile = await runCli(['review'], { exec: gh.exec, fetch: srvFile.fetch, stateDir: badStateFile });
  assert.equal(rFile.code, 4);
  assert.equal(srvFile.requests.some((x) => x.method === 'POST'), false);

  // 8c. Post-acceptance saveLatest failure (e.g. disk full after POST accepted):
  //     capped wait and --no-wait both print an accurate recovery command with app:<uuid> instead of broken no-ID /megalens:result
  const clk = fakeClock();
  const srvRunning = makeAppServer({
    pollHandler: () => jsonResp(200, makeJob({ status: 'running', result_status: null, findings: null })),
  });
  const rCap = await appReview({
    exec: gh.exec,
    fetch: srvRunning.fetch,
    cwd: '/repo-app',
    env: { MEGALENS_TOKEN: TOKEN },
    now: clk.now,
    sleep: clk.sleep,
    canSaveLatest: () => true,
    saveLatest: () => false,
  });
  assert.equal(rCap.code, 0);
  assert.equal(rCap.text.includes(STILL_RUNNING_LINE), false, 'must not promise broken no-ID /megalens:result when bookmark failed');
  assert.match(rCap.text, new RegExp(`Could not save the local bookmark; run /megalens:result app:${JOB1} to see it\\.`));

  const rNoWait = await appReview({
    exec: gh.exec,
    fetch: srvRunning.fetch,
    cwd: '/repo-app',
    env: { MEGALENS_TOKEN: TOKEN },
    wait: false,
    canSaveLatest: () => true,
    saveLatest: () => false,
  });
  assert.equal(rNoWait.code, 0);
  assert.match(rNoWait.text, new RegExp(`/megalens:result app:${JOB1}`));
});

test('LOOP-CONFIRM1 NEW High + #7 + #9 + #2: PR switch at same SHA, Enterprise checkout move, saved-job Retry-After: 60, and --no-wait moved PR', async (t) => {
  const H2 = 'd'.repeat(40);
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-loop2-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  let currentPr = 41;
  let host = 'github.com';
  let localHead = H;
  let rateLimitMode = null; // null | 'always' | 'once'
  let rateLimitHits = 0;
  const calls = [];
  const requests = [];

  const exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok('/repo-loop2\n');
    if (cmd === 'git' && args[0] === 'rev-parse') return ok(`${localHead}\n`);
    if (cmd === 'git' && args[0] === 'status') return ok('');
    if (cmd === 'git' && args[0] === 'for-each-ref') return ok('');
    if (cmd === 'git' && args[0] === 'branch') return ok(`feature-${currentPr ?? 'ref'}\n`);
    if (cmd === 'gh' && ['--version', 'auth'].includes(args[0])) return ok('');
    if (cmd === 'gh' && args[0] === 'repo') {
      return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' }, url: `https://${host}/acme/widget` }));
    }
    if (cmd === 'gh' && args[0] === 'api' && args.some((a) => a.includes('/commits/'))) return ok(`${localHead}\n`);
    if (cmd === 'gh' && args[0] === 'api' && args.some((a) => a.includes('/contents/'))) return bad('HTTP 404');
    if (cmd === 'gh' && args[0] === 'pr') {
      if (currentPr === null) return bad('no pull requests found for branch');
      return ok(JSON.stringify({
        number: currentPr,
        state: 'OPEN',
        isDraft: false,
        headRefOid: localHead,
        baseRefOid: B,
        isCrossRepository: false,
        url: `https://github.com/acme/widget/pull/${currentPr}`,
      }));
    }
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };

  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push([method, u.pathname, body]);
    if (u.pathname === '/api/github-app/status') {
      return jsonResp(200, { installed: true, linked: true, notice_accepted: true, suspended: false });
    }
    if (u.pathname === '/api/github-app/review-now' && method === 'POST') {
      const jid = body.pr === 42 ? JOB2 : JOB1;
      return jsonResp(202, { job_id: jid, status_url: `/api/github-app/review-now/${jid}` });
    }
    if (u.pathname.startsWith('/api/github-app/review-now/')) {
      if (rateLimitMode === 'always' || (rateLimitMode === 'once' && rateLimitHits === 0)) {
        rateLimitHits += 1;
        return jsonResp(429, { error: 'rate_limited' }, { 'retry-after': '60' });
      }
      const isPr42 = u.pathname.endsWith(JOB2);
      return jsonResp(200, makeJob({
        job_id: isPr42 ? JOB2 : JOB1,
        head_sha: H,
        pr_url: `https://github.com/acme/widget/pull/${isPr42 ? 42 : 41}`,
        findings: isPr42
          ? makeDoc({ findings: [{ id: 'f42', file: 'sample.txt', line_start: 1, title: 'Only applies to PR 42', claim: 'PR 42 bug', priority: 'P1', strength: 'strong', found_by: ['codex-standard'] }] })
          : makeDoc({ findings: [] }),
      }));
    }
    return jsonResp(404, { error: 'not_found' });
  };

  // 1. Initial review on PR #41 -> clean result, bookmarks JOB1 for PR #41
  const r41 = await runCli(['review'], { exec, fetch, stateDir, cwd: '/repo-loop2' });
  assert.equal(r41.code, 0, r41.text);
  assert.match(r41.text, /No findings were reported by a complete review/);

  // 2. NEW High: Switch to PR #42 at the EXACT SAME SHA -> MUST resolve PR #42, submit PR #42, and report PR #42's finding!
  currentPr = 42;
  calls.length = 0;
  requests.length = 0;
  const r42 = await runCli(['review'], { exec, fetch, stateDir, cwd: '/repo-loop2' });
  assert.equal(r42.code, 0, r42.text);
  assert.equal(calls.some((c) => c.startsWith('gh pr ')), true, 'must resolve current PR before reusing bookmark');
  assert.equal(requests.some(([m, p, b]) => m === 'POST' && p === '/api/github-app/review-now' && b?.pr === 42), true);
  assert.match(r42.text, /Only applies to PR 42/);

  // 3. Reopened #7: Move same checkout to GitHub Enterprise -> MUST run gh repo view and make ZERO App API calls!
  host = 'github.enterprise.example';
  calls.length = 0;
  requests.length = 0;
  const rGhe = await runCli(['review'], { exec, fetch, stateDir, cwd: '/repo-loop2' });
  assert.equal(rGhe.code, 4);
  assert.equal(calls.some((c) => c.startsWith('gh repo ')), true, 'must check repo host before reusing bookmark');
  assert.equal(requests.length, 0, 'Enterprise checkout must make zero github.com App API calls');
  assert.match(rGhe.text, /github\.enterprise\.example/);

  // 4. #9: First read of a saved job gets 429 Retry-After: 60 -> waits 60s and recovers (and with persistent 429 + mock sleep without mock now, waits full waitMs budget!)
  host = 'github.com';
  rateLimitMode = 'once';
  rateLimitHits = 0;
  let sleptOnce = 0;
  requests.length = 0;
  const rRecover = await runCli(['review'], {
    exec,
    fetch,
    stateDir,
    cwd: '/repo-loop2',
    timing: { waitMs: 120_000, sleep: async (ms) => { sleptOnce += ms; } },
  });
  assert.equal(rRecover.code, 0, rRecover.text);
  assert.equal(sleptOnce, 60_000, 'must sleep Retry-After: 60 before retrying saved job read');
  assert.equal(requests.some(([m]) => m === 'POST'), false, 'zero second POST when recovering saved job');
  assert.match(rRecover.text, /Only applies to PR 42/);

  rateLimitMode = 'always';
  let sleptCap = 0;
  requests.length = 0;
  const rCap = await runCli(['review'], {
    exec,
    fetch,
    stateDir,
    cwd: '/repo-loop2',
    timing: { waitMs: 120_000, sleep: async (ms) => { sleptCap += ms; } },
  });
  assert.equal(rCap.code, 0, rCap.text);
  assert.equal(sleptCap, 120_000, 'must wait across full budget respecting Retry-After: 60 even when only sleep is mocked');
  assert.ok(rCap.text.includes(STILL_RUNNING_LINE));
  assert.equal(rCap.text.includes(JOB2), false);
  assert.equal(requests.some(([m]) => m === 'POST'), false);

  // 5. #2: Moved PR with --no-wait -> no-ID /megalens:result and /megalens:status MUST reject wrong-head findings until user pulls moved head!
  const stateDirMoved = mkdtempSync(path.join(tmpdir(), 'mlapp-moved-'));
  t.after(() => rmSync(stateDirMoved, { recursive: true, force: true }));
  let movedHeadLocal = H;
  let movedPosts = 0;
  const execMoved = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok('/repo-moved\n');
    if (cmd === 'git' && args[0] === 'rev-parse') return ok(`${movedHeadLocal}\n`);
    if (cmd === 'git' && args[0] === 'status') return ok('');
    if (cmd === 'git' && args[0] === 'for-each-ref') return ok('');
    if (cmd === 'git' && args[0] === 'branch') return ok('feature-41\n');
    if (cmd === 'gh' && ['--version', 'auth'].includes(args[0])) return ok('');
    if (cmd === 'gh' && args[0] === 'repo') {
      return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' }, url: 'https://github.com/acme/widget' }));
    }
    if (cmd === 'gh' && args[0] === 'api' && args.some((a) => a.includes('/commits/'))) return ok(`${movedHeadLocal}\n`);
    if (cmd === 'gh' && args[0] === 'pr') {
      return ok(JSON.stringify({
        number: 41, state: 'OPEN', isDraft: false, headRefOid: movedHeadLocal, baseRefOid: B, isCrossRepository: false,
        url: 'https://github.com/acme/widget/pull/41',
      }));
    }
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const fetchMoved = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/github-app/status') return jsonResp(200, { installed: true, linked: true, notice_accepted: true, suspended: false });
    if (u.pathname === '/api/github-app/review-now' && init.method === 'POST') {
      movedPosts += 1;
      return jsonResp(202, { job_id: JOB1, status_url: `/api/github-app/review-now/${JOB1}` });
    }
    if (u.pathname === `/api/github-app/review-now/${JOB1}`) {
      return jsonResp(200, makeJob({
        job_id: JOB1,
        head_sha: H2,
        pr_url: 'https://github.com/acme/widget/pull/41',
        findings: makeDoc({ findings: [{ id: 'fm', file: 'sample.txt', line_start: 1, title: 'Only applies to the moved head', claim: 'moved', priority: 'P1', strength: 'strong', found_by: ['codex-standard'] }] }),
      }));
    }
    return jsonResp(404, { error: 'not_found' });
  };

  const accepted = await runCli(['review', '--no-wait'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirMoved, cwd: '/repo-moved' });
  assert.equal(accepted.code, 0, accepted.text);
  assert.equal(movedPosts, 1);

  // Re-running /megalens:review before git pull stops with head mismatch and makes ZERO second POST
  const rerunBeforePull = await runCli(['review'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirMoved, cwd: '/repo-moved' });
  assert.equal(rerunBeforePull.code, 4);
  assert.equal(movedPosts, 1, 'must NOT submit a second POST when PR moved on GitHub');
  assert.match(rerunBeforePull.text, /Pull request #41 on GitHub moved to commit ddddddd/);
  assert.equal(rerunBeforePull.text.includes('Only applies to the moved head'), false);

  // No-ID result while still at old SHA H -> MUST refuse to render H2 findings and keep bookmark accurate
  const resBeforePull1 = await runCli(['result'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirMoved, cwd: '/repo-moved' });
  assert.equal(resBeforePull1.code, 4);
  assert.match(resBeforePull1.text, /Pull request #41 on GitHub moved to commit ddddddd/);
  assert.equal(resBeforePull1.text.includes('Only applies to the moved head'), false, 'must NOT render moved-head findings for old local SHA');
  const bmAfter = loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDirMoved }, repoKey: '/repo-moved' });
  assert.equal(bmAfter?.headSha, H2);
  assert.equal(bmAfter?.requestedHeadSha, H);

  // Fresh --no-wait -> direct no-ID result (without intermediate /megalens:review) ALSO rejects wrong-head findings and fixes bookmark
  const stateDirDirect = mkdtempSync(path.join(tmpdir(), 'mlapp-moved-direct-'));
  t.after(() => rmSync(stateDirDirect, { recursive: true, force: true }));
  const acceptedDirect = await runCli(['review', '--no-wait'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirDirect, cwd: '/repo-moved' });
  assert.equal(acceptedDirect.code, 0, acceptedDirect.text);
  const directRes = await runCli(['result'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirDirect, cwd: '/repo-moved' });
  assert.equal(directRes.code, 4);
  assert.match(directRes.text, /Pull request #41 on GitHub moved to commit ddddddd/);
  assert.equal(directRes.text.includes('Only applies to the moved head'), false);
  const bmDirect = loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDirDirect }, repoKey: '/repo-moved' });
  assert.equal(bmDirect?.headSha, H2);
  assert.equal(bmDirect?.requestedHeadSha, H);

  // Second no-ID result AND no-ID status BEFORE git pull -> STILL refuse to render wrong-head findings
  const resBeforePull2 = await runCli(['result'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirMoved, cwd: '/repo-moved' });
  assert.equal(resBeforePull2.code, 4);
  assert.equal(resBeforePull2.text.includes('Only applies to the moved head'), false);

  const stBeforePull = await runCli(['status'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirMoved, cwd: '/repo-moved' });
  assert.equal(stBeforePull.code, 4);
  assert.match(stBeforePull.text, /moved to commit ddddddd/);

  // After user pulls H2 locally -> no-ID result renders H2 findings cleanly (exit 0) and clears requestedHeadSha
  movedHeadLocal = H2;
  const resAfterPull = await runCli(['result'], { exec: execMoved, fetch: fetchMoved, stateDir: stateDirMoved, cwd: '/repo-moved' });
  assert.equal(resAfterPull.code, 0, resAfterPull.text);
  assert.match(resAfterPull.text, /Only applies to the moved head/);
  assert.equal(loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDirMoved }, repoKey: '/repo-moved' })?.requestedHeadSha, null);
});

test('LOOP-CONFIRM2: moved PR rerun after no-ID result (#2), Enterprise no-ID result/status (#7), retargeted PR base (NEW High 1), and PR lookup outage (NEW High 2)', async (t) => {
  const A = 'a'.repeat(40);
  const B1 = 'b'.repeat(40);
  const B2 = 'c'.repeat(40);
  const D = 'd'.repeat(40);
  const ID1 = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  const ID3 = '33333333-3333-4333-8333-333333333333';
  const PR_URL = 'https://github.com/acme/widget/pull/41';
  const cleanDoc = makeDoc({ findings: [] });
  const diffDoc = makeDoc({
    findings: [{
      id: 'f-diff',
      file: 'checkout.js',
      line_start: 1,
      title: 'Issue in the new PR diff',
      claim: 'Earlier commit skipped verification',
      priority: 'P1',
      strength: 'strong',
      found_by: ['codex-standard'],
    }],
  });

  function makeLoop3Fixture({ moveAtSubmit = false, prLookupErr = null, hasGh = true } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mlapp-loop3-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = {
      host: 'github.com',
      nwo: 'acme/widget',
      localHead: A,
      prHead: A,
      baseSha: B1,
      baseRef: 'main',
      posts: [],
      reads: [],
      remoteUrl: 'https://github.com/acme/widget.git',
    };
    const jobs = new Map();
    const exec = async (cmd, args) => {
      if (cmd === 'gh' && !hasGh) return bad('gh: command not found', 127);
      if (cmd === 'git' && args[0] === 'rev-parse') return ok(args.includes('--show-toplevel') ? '/fixture/widget\n' : `${state.localHead}\n`);
      if (cmd === 'git' && args[0] === 'status') return ok('');
      if (cmd === 'git' && args[0] === 'for-each-ref') return ok('');
      if (cmd === 'git' && args[0] === 'branch') return ok('feature\n');
      if (cmd === 'git' && args[0] === 'remote') return ok(`${state.remoteUrl}\n`);
      if (cmd === 'gh' && ['--version', 'auth'].includes(args[0])) return ok('');
      if (cmd === 'gh' && args[0] === 'repo') {
        return ok(JSON.stringify({ nameWithOwner: state.nwo, url: `https://${state.host}/${state.nwo}`, defaultBranchRef: { name: 'main' } }));
      }
      if (cmd === 'gh' && args[0] === 'pr') {
        if (prLookupErr) return bad(prLookupErr);
        return ok(JSON.stringify({
          number: 41,
          state: 'OPEN',
          isDraft: false,
          isCrossRepository: false,
          headRefOid: state.prHead,
          baseRefOid: state.baseSha,
          baseRefName: state.baseRef,
          url: `https://github.com/${state.nwo}/pull/41`,
        }));
      }
      if (cmd === 'gh' && args[0] === 'api' && args.some((arg) => arg.includes('/commits/'))) return ok(`${state.localHead}\n`);
      if (cmd === 'gh' && args[0] === 'api' && args.some((arg) => arg.includes('/contents/'))) return bad('HTTP 404');
      if (cmd === 'gh' && args[0] === 'run') return ok('[]');
      return bad(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const fetch = async (url, init = {}) => {
      const route = new URL(String(url)).pathname;
      if (route === '/api/github-app/status') {
        return jsonResp(200, { installed: true, linked: true, notice_accepted: true, suspended: false });
      }
      if (route === '/api/github-app/review-now' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        state.posts.push(body);
        const id = body.pr ? (state.baseSha === B1 && state.baseRef === 'main' ? ID1 : ID3) : ID2;
        if (body.pr && moveAtSubmit) state.prHead = D;
        jobs.set(id, makeJob({
          job_id: id,
          head_sha: body.ref || state.prHead,
          pr_url: body.pr ? PR_URL : null,
          findings: (id === ID3 || (body.pr && moveAtSubmit)) ? diffDoc : cleanDoc,
        }));
        return jsonResp(202, { job_id: id, status_url: `${route}/${id}` });
      }
      const id = route.split('/').at(-1);
      state.reads.push(id);
      return jobs.has(id) ? jsonResp(200, jobs.get(id)) : jsonResp(404, { error: 'not_found' });
    };
    const run = (argv, extraEnv = {}) => runCli(argv, { exec, fetch, stateDir: dir, cwd: '/fixture/widget', env: extraEnv });
    return { state, run, dir };
  }

  // 1. Finding #2 (High): Moved PR -> --no-wait -> no-ID result -> review rerun MUST stop with exit 4 and ZERO second POST (no fallback to {ref: A})
  {
    const f = makeLoop3Fixture({ moveAtSubmit: true });
    const first = await f.run(['review', '--no-wait']);
    assert.equal(first.code, 0, first.text);
    const refused = await f.run(['result']);
    assert.equal(refused.code, 4);
    assert.match(refused.text, /Pull request #41 on GitHub moved to commit ddddddd/);
    assert.equal(refused.text.includes('Issue in the new PR diff'), false);

    // Rerunning /megalens:review while still on local commit A (PR #41 now at D on GitHub) must NOT submit { ref: A }
    const repeated = await f.run(['review']);
    assert.equal(repeated.code, 4);
    assert.deepEqual(f.state.posts, [{ repo: 'acme/widget', tier: 'standard', pr: 41 }], 'must NEVER submit a second POST or fall back to commit ref');
    assert.match(repeated.text, /Pull request #41 on GitHub moved to commit ddddddd/);
    assert.equal(repeated.text.includes('Issue in the new PR diff'), false);

    // Explicit --runner app on a moved PR also stops before POST
    const forced = await f.run(['review', '--runner', 'app']);
    assert.equal(forced.code, 4);
    assert.equal(f.state.posts.length, 1);

    // After git pull (local HEAD = D), no-ID result renders the moved PR's findings cleanly
    f.state.localHead = D;
    const afterPull = await f.run(['result']);
    assert.equal(afterPull.code, 0, afterPull.text);
    assert.match(afterPull.text, /Issue in the new PR diff/);
  }

  // 2. Finding #7 (Medium): Enterprise checkout on no-ID /megalens:result and /megalens:status MUST make ZERO App API calls
  {
    const f = makeLoop3Fixture();
    const started = await f.run(['review', '--no-wait']);
    assert.equal(started.code, 0, started.text);
    f.state.host = 'github.enterprise.example';
    f.state.reads.length = 0;

    const res = await f.run(['result']);
    assert.equal(res.code, 4);
    assert.deepEqual(f.state.reads, [], 'Enterprise no-ID result must NOT query github.com App job');
    assert.match(res.text, /No recent MegaLens review found/);

    const st = await f.run(['status']);
    assert.equal(st.code, 4);
    assert.deepEqual(f.state.reads, [], 'Enterprise no-ID status must NOT query github.com App job');

    // Also verify no-gh Enterprise origin remote and GH_HOST override reject github.com App bookmark
    const fNoGh = makeLoop3Fixture({ hasGh: false });
    await fNoGh.run(['review', '--no-wait']);
    fNoGh.state.remoteUrl = 'git@github.enterprise.example:acme/widget.git';
    fNoGh.state.reads.length = 0;
    const resNoGh = await fNoGh.run(['result']);
    assert.equal(resNoGh.code, 4);
    assert.deepEqual(fNoGh.state.reads, []);
  }

  // 3. NEW High #1: Retargeting an open PR (changing base SHA or base branch while keeping head SHA unchanged) MUST NOT reuse stale clean result
  {
    const f = makeLoop3Fixture();
    const first = await f.run(['review']);
    assert.equal(first.code, 0, first.text);
    assert.match(first.text, /No findings were reported/);
    assert.equal(f.state.posts.length, 1);

    // Retarget base SHA from B1 to B2 while head stays A -> must submit a fresh PR review and surface the new diff's finding
    f.state.baseSha = B2;
    const repeated = await f.run(['review']);
    assert.equal(repeated.code, 0, repeated.text);
    assert.equal(f.state.posts.length, 2, 'retargeted PR base must submit a new review instead of reusing stale clean bookmark');
    assert.deepEqual(f.state.posts[1], { repo: 'acme/widget', tier: 'standard', pr: 41 });
    assert.match(repeated.text, /Issue in the new PR diff/);

    // Once reviewed at B2, repeating again with unchanged B2 reuses the bookmark with ZERO third POST
    const reusedB2 = await f.run(['review']);
    assert.equal(reusedB2.code, 0, reusedB2.text);
    assert.equal(f.state.posts.length, 2);
    assert.match(reusedB2.text, /Issue in the new PR diff/);

    // Explicit --runner app also detects retargeted baseRef (e.g. main -> release) via Layer 1 dedupe
    f.state.baseRef = 'release';
    const retargetRef = await f.run(['review', '--runner', 'app']);
    assert.equal(retargetRef.code, 0, retargetRef.text);
    assert.equal(f.state.posts.length, 3);
  }

  // 4. NEW High #2: PR lookup outage (e.g. gh pr view returns GraphQL: HTTP 502) MUST fail closed with ZERO POST (never silently narrow to commit-only ref)
  {
    const f = makeLoop3Fixture({ prLookupErr: 'GraphQL: HTTP 502' });
    const r = await f.run(['review']);
    assert.equal(r.code, 4);
    assert.deepEqual(f.state.posts, [], 'PR lookup outage must NOT submit a narrowed commit-only review');
    assert.match(r.text, /Could not check whether branch feature has an open pull request/i);
    assert.match(r.text, /HTTP 502/);
    assert.match(r.text, /Nothing was started and no credit was used/i);

    // Also fail closed when a saved bookmark already exists and gh pr view hits HTTP 502
    const fWithBm = makeLoop3Fixture();
    await fWithBm.run(['review', '--no-wait']);
    const fOutage = makeLoop3Fixture({ prLookupErr: 'GraphQL: HTTP 502' });
    saveLatestReview({
      env: { MEGALENS_STATE_DIR: fOutage.dir },
      repoKey: '/fixture/widget',
      id: `app:${ID1}`,
      runner: 'app',
      nwo: 'acme/widget',
      tier: 'standard',
      headSha: A,
      prNumber: 41,
      prBaseSha: B1,
    });
    const rBm = await fOutage.run(['review']);
    assert.equal(rBm.code, 4);
    assert.deepEqual(fOutage.state.posts, []);
    assert.deepEqual(fOutage.state.reads, [], 'must not serve a potentially-stale bookmark when PR lookup fails');
    assert.match(rBm.text, /HTTP 502/);
  }
});
