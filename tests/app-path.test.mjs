// Fixture tests (zero network) for the MegaLens GitHub App on-demand path:
//   GET /api/github-app/status, POST /api/github-app/review-now, GET /api/github-app/review-now/[id]
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  APP_BILLING_URL, APP_INSTALL_URL, APP_PATH_ENABLED, WORKFLOW_PATH,
  appResult, appReview, appStatus, checkAppStatus, isAppId, parseGitHubRemote, resolveAppApiBase,
} from '../scripts/lib/gh-runner.mjs';
import { loadLatestReview, saveLatestReview, stateFilePath } from '../scripts/lib/latest-review.mjs';
import { DEFAULT_WAIT_MS, STILL_RUNNING_LINE } from '../scripts/lib/wait-loop.mjs';
import { main } from '../scripts/engine.mjs';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TOKEN = 'ml_tok_' + '9'.repeat(32);
const JOB1 = '11111111-1111-4111-8111-111111111111';
const JOB2 = '22222222-2222-4222-8222-222222222222';
const SETUP_LINE = `Install the MegaLens GitHub App or add the workflow: ${APP_INSTALL_URL}`;
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
  defaultBranch = 'main',
  hasGh = true,
  remoteUrl = `https://github.com/${nwo}.git`,
  workflowPresent = false,
  dirty = false,
  pushed = true,
  openPr = null, // { number, state: 'OPEN', isDraft: false, headRefOid: H, isCrossRepository: false }
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
    if (k.startsWith('gh auth')) return ok('Logged in');
    if (k.startsWith('gh repo')) return ok(JSON.stringify({ nameWithOwner: nwo, defaultBranchRef: { name: defaultBranch }, url: `https://github.com/${nwo}` }));
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

async function runCli(argv, { exec, fetch, stateDir, cwd = '/repo-app', env = {}, timing = {}, signal = null } = {}) {
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), 'mlapp-'));
  let text = '';
  let errText = '';
  const code = await main(argv, {
    exec,
    fetch,
    cwd,
    env: { PATH: process.env.PATH, HOME: dir, MEGALENS_STATE_DIR: dir, MEGALENS_TOKEN: TOKEN, GH_TOKEN: 'ghp_test1234567890', ...env },
    out: (s) => { text += s; },
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
    openPr: { number: 42, state: 'OPEN', isDraft: false, headRefOid: H, isCrossRepository: false },
  });
  const srv = makeAppServer({
    pollSequence: [makeJob({ tier: 'deep', pr_url: 'https://github.com/acme/widget/pull/42', findings: makeDoc({ tier: 'deep' }) })],
  });

  const r = await runCli(['review', 'deep'], { exec: gh.exec, fetch: srv.fetch, stateDir });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /## MegaLens deep review: complete/);
  const post = srv.requests.find((x) => x.method === 'POST');
  assert.deepEqual(post.body, { repo: 'acme/widget', tier: 'deep', pr: 42 });
  assert.equal(r.text.includes(JOB1), false);
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

  // 409 review_finishing must NOT auto-retry into a second paid review
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
  assert.match(rFin.text, /finishing on GitHub right now/i);
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

test('Token & URL security: refuses plain http non-loopback, refuses redirects, scrubs token everywhere', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-sec-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  assert.equal(resolveAppApiBase({}).origin, 'https://megalens.ai');
  assert.equal(resolveAppApiBase({ MEGALENS_API_URL: 'https://staging.megalens.ai/api/v2' }).origin, 'https://staging.megalens.ai');
  assert.equal(resolveAppApiBase({ MEGALENS_API_URL: 'http://127.0.0.1:3000/api/v2' }).origin, 'http://127.0.0.1:3000');
  assert.match(resolveAppApiBase({ MEGALENS_API_URL: 'http://evil.example/api' }).error, /must be https/);
  assert.match(resolveAppApiBase({ MEGALENS_API_URL: 'https://user:pass@megalens.ai' }).error, /credentials/);

  // Plain http non-loopback makes ZERO fetch calls
  let fetchCalled = false;
  const stBadUrl = await checkAppStatus({
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_API_URL: 'http://evil.example' },
    nwo: 'acme/widget',
    fetch: async () => { fetchCalled = true; return jsonResp(200, {}); },
  });
  assert.equal(fetchCalled, false);
  assert.equal(stBadUrl.state, 'bad_url');

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

test('Transient 502 during poll retries GET once and keeps bookmark on repeated poll error', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlapp-poll-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gh = makeGitGhExec();

  // 1 transient 502 -> retries GET and completes cleanly (still only 1 POST)
  let polls1 = 0;
  const srv1 = makeAppServer({
    pollHandler: () => (++polls1 === 1 ? jsonResp(502, { error: 'bad_gateway' }) : jsonResp(200, makeJob())),
  });
  const r1 = await runCli(['review'], { exec: gh.exec, fetch: srv1.fetch, stateDir });
  assert.equal(r1.code, 0, r1.text);
  assert.equal(srv1.requests.filter((x) => x.method === 'POST').length, 1);
  assert.match(r1.text, /Off-by-one in discount calculation/);

  // 2 consecutive 502s -> fails wait, keeps bookmark so /megalens:result can recover
  const stateDir2 = mkdtempSync(path.join(tmpdir(), 'mlapp-poll2-'));
  t.after(() => rmSync(stateDir2, { recursive: true, force: true }));
  const srv2 = makeAppServer({
    pollHandler: () => jsonResp(502, { error: 'bad_gateway' }),
  });
  const r2 = await runCli(['review'], { exec: gh.exec, fetch: srv2.fetch, stateDir: stateDir2 });
  assert.equal(r2.code, 4);
  assert.equal(loadLatestReview({ env: { MEGALENS_STATE_DIR: stateDir2 }, repoKey: '/repo-app' })?.id, `app:${JOB1}`);

  // Explicit app: status on a newly saved bookmark when API recovers
  const srvRecover = makeAppServer({ pollSequence: [makeJob({ status: 'done', result_status: 'complete' })] });
  const rStatus = await appStatus({ env: { MEGALENS_TOKEN: TOKEN }, fetch: srvRecover.fetch }, `app:${JOB1}`, { showId: false });
  assert.equal(rStatus.code, 0);
  assert.match(rStatus.text, /Finished\. Run \/megalens:result to see it\./);

  // Bookmark for different commit/tier does NOT reuse old job
  saveLatestReview({ env: { MEGALENS_STATE_DIR: stateDir2 }, repoKey: '/repo-app', id: `app:${JOB2}`, runner: 'app', nwo: 'acme/widget', tier: 'deep', headSha: H });
  const srvNew = makeAppServer({ pollSequence: [makeJob({ tier: 'standard' })] });
  const rStd = await runCli(['review'], { exec: gh.exec, fetch: srvNew.fetch, stateDir: stateDir2 });
  assert.equal(rStd.code, 0);
  assert.equal(srvNew.requests.filter((x) => x.method === 'POST').length, 1, 'different tier must submit fresh job');
});
