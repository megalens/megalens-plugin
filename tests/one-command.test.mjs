// Tests for the ONE-COMMAND plugin UX:
//   1. Runner auto-pick (GitHub App -> user's GitHub runner -> one clear setup line)
//   2. Wait loop with fake clock (progress lines, inline completion with no id, 20-min cap, abort)
//   3. No-id /megalens:result and /megalens:status (saved bookmark + remote fallback + multi-repo isolation)
//   4. README main path = 2 steps (no --runner or ids in main path)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectRemoteRunner, appReview, appStatus, appResult, mapCheckState, findLatestRemoteReview, startRun, runnerReview, realExec, CHECK_NAME, APP_INSTALL_URL, WORKFLOW_FILE } from '../scripts/lib/gh-runner.mjs';
import { waitForReview, DEFAULT_WAIT_MS, STILL_RUNNING_LINE } from '../scripts/lib/wait-loop.mjs';
import { saveLatestReview, loadLatestReview, stateFilePath } from '../scripts/lib/latest-review.mjs';
import { secretContent } from '../scripts/lib/safety.mjs';
import { main, pickNewerReview } from '../scripts/engine.mjs';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TOKEN = 'ml_SECRETTOKEN1234567890';
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'err', code = 1) => ({ code, stdout: '', stderr });

function fakeClock() {
  let t = 1_700_000_000_000;
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
    review_id: 'rv_abc12345',
    tier: 'standard',
    status: 'complete',
    passes: [{ name: 'codex-standard', model: 'gpt-6.2-sol', effort: 'medium', status: 'ok' }],
    findings: [{ id: 'f1', file: 'total.js', line_start: 3, line_end: 3, title: 'Adds instead of multiplying', claim: 'unitPrice + quantity', failure_scenario: '3 items at 200 cents gives 203', priority: 'P1', strength: 'strong', found_by: ['codex-standard'] }],
    ...extra,
  };
}

function makeAppCheckRun(overrides = {}) {
  return {
    id: 55501,
    name: CHECK_NAME,
    status: 'completed',
    conclusion: 'neutral',
    html_url: 'https://github.com/acme/widget/runs/55501',
    app: { slug: 'megalens' },
    output: {
      title: '1 strong finding, 1 in total',
      summary: '### Strong findings\n- **P1** `total.js:3`: Adds instead of multiplying',
    },
    ...overrides,
  };
}

/** Flexible fake gh + git for testing auto-pick, App reviews, GitHub runner reviews, and no-id result/status. */
function makeScenario({
  repoRoot = '/repo-a',
  nwo = 'acme/widget',
  defaultBranch = 'main',
  branch = 'feature',
  orgInstallations = null, // null -> HTTP 404/403 (inaccessible); array -> HTTP 200
  userInstallations = null, // null -> HTTP 403 (inaccessible); array -> HTTP 200
  installRepos = null, // map of instId -> [full_name, ...]
  appSuites = [],
  headSuites = null,
  defaultSuites = null,
  appChecks = [],
  headChecks = null,
  defaultChecks = null,
  workflowPresent = false,
  checkRunSequence = null,
  ghRunSequence = null,
  downloadDoc = makeDoc(),
  openPrs = [],
  existingRuns = [],
  runsAfterDispatch = null,
  onDownload = null,
} = {}) {
  const calls = [];
  let dispatched = false;
  let checkIdx = 0;
  let runIdx = 0;
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, signal: opts?.signal });
    const k = `${cmd} ${args.slice(0, 2).join(' ')}`;
    if (k.startsWith('gh --version')) return ok('gh version 2.60.0');
    if (k.startsWith('gh auth')) return ok('Logged in');
    if (k.startsWith('gh repo')) return ok(JSON.stringify({ nameWithOwner: nwo, defaultBranchRef: { name: defaultBranch }, url: `https://github.com/${nwo}` }));
    if (k.startsWith('git rev-parse') && args.includes('--show-toplevel')) return ok(`${repoRoot}\n`);
    if (k.startsWith('git rev-parse')) return ok(`${H}\n`);
    if (k.startsWith('git merge-base')) return ok(`${B}\n`);
    if (k.startsWith('git status')) return ok('');
    if (k.startsWith('git branch')) return ok(`${branch}\n`);
    if (k.startsWith('gh secret')) return ok(JSON.stringify([{ name: 'MEGALENS_TOKEN' }]));
    if (k.startsWith('gh api') && args.some((a) => /^orgs\/[^/]+\/installations$/.test(a))) {
      return orgInstallations === null ? bad('HTTP 403: Must have admin rights') : ok(JSON.stringify(orgInstallations));
    }
    if (k.startsWith('gh api') && args.some((a) => /^user\/installations\/\d+\/repositories$/.test(a))) {
      const m = args.find((a) => /^user\/installations\/(\d+)\/repositories$/.test(a)).match(/user\/installations\/(\d+)\/repositories/);
      const list = installRepos?.[Number(m[1])];
      return list ? ok(JSON.stringify(list)) : bad('HTTP 403');
    }
    if (k.startsWith('gh api') && args.some((a) => a === 'user/installations')) {
      return userInstallations === null ? bad('HTTP 403: Requires GitHub App user token') : ok(JSON.stringify(userInstallations));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/check-suites'))) {
      const isHead = args.some((a) => a.includes(`/commits/${H}/check-suites`));
      const suites = isHead ? (headSuites ?? appSuites) : (defaultSuites ?? appSuites);
      return ok(JSON.stringify(suites));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/check-runs/'))) {
      const seq = checkRunSequence ?? [makeAppCheckRun()];
      const cr = seq[Math.min(checkIdx++, seq.length - 1)];
      return ok(JSON.stringify(cr));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/check-runs'))) {
      const isHead = args.some((a) => a.includes(`/commits/${H}/check-runs`));
      const checks = isHead ? (headChecks ?? appChecks) : (defaultChecks ?? appChecks);
      return ok(JSON.stringify({ check_runs: checks }));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/contents/'))) return workflowPresent ? ok('file\n') : bad('HTTP 404');
    if (k.startsWith('gh api') && args.some((a) => a.includes('/branches-where-head'))) return ok(JSON.stringify([branch]));
    if (k.startsWith('gh api') && args.some((a) => a.includes('/compare/'))) return ok('diverged');
    if (k.startsWith('gh api') && args.some((a) => a.includes('/pulls'))) return ok(JSON.stringify(openPrs));
    if (k.startsWith('gh api') && args.some((a) => a === `repos/${nwo}/commits`)) return ok(JSON.stringify([]));
    if (k.startsWith('gh api') && args.some((a) => a.includes('/commits/'))) return ok(`${H}\n`);
    if (k.startsWith('gh workflow run')) { dispatched = true; return ok(''); }
    if (k.startsWith('gh run list')) {
      const title = `MegaLens standard ${B}..${H}`;
      const rows = runsAfterDispatch ?? [{ databaseId: 9001, displayTitle: title, createdAt: new Date().toISOString(), url: `https://github.com/${nwo}/actions/runs/9001` }];
      return ok(JSON.stringify(dispatched ? [...rows, ...existingRuns] : existingRuns));
    }
    if (k.startsWith('gh run view')) {
      const seq = ghRunSequence ?? [{ status: 'completed', conclusion: 'success' }];
      const cur = seq[Math.min(runIdx++, seq.length - 1)];
      const runIdArg = args[2] || '9001';
      return ok(JSON.stringify({ status: cur.status, conclusion: cur.conclusion ?? '', url: `https://github.com/${nwo}/actions/runs/${runIdArg}`, workflowName: 'MegaLens Dispatch', displayTitle: 't' }));
    }
    if (k.startsWith('gh run download')) {
      if (onDownload) return await onDownload(args, opts);
      const dir = args[args.indexOf('-D') + 1];
      if (!downloadDoc) return bad('no artifact');
      writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(downloadDoc));
      return ok('');
    }
    return bad(`unexpected: ${k} ${args.join(' ')}`, 99);
  };
  return { exec, calls };
}

async function runMain(argv, { exec, stateDir, cwd = '/repo-a', platform = 'darwin', env = {}, timing = {}, signal = null, flags = {} } = {}) {
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), 'mlone-'));
  let text = '';
  const code = await main(argv, {
    platform,
    exec,
    cwd,
    env: { PATH: process.env.PATH, HOME: dir, MEGALENS_STATE_DIR: dir, GH_TOKEN: 'ghp_testtoken1234567890', ...env },
    out: (s) => { text += s; },
    err: () => {},
    flags: { ...flags, runnerTiming: { sleepMs: 1, tries: 2, ...timing } },
    signal,
  });
  return { code, text, stateDir: dir };
}

// ---- 1. Runner auto-pick ----

test('auto-pick: prefers our review machine via GitHub App when installed, even if workflow is also present', async () => {
  const sc = makeScenario({
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: null }],
    appSuites: ['megalens'],
    appChecks: [makeAppCheckRun()],
    workflowPresent: true,
  });
  const det = await detectRemoteRunner({ exec: sc.exec, cwd: '/repo-a', env: {} });
  assert.equal(det.runner, 'app');
  assert.equal(det.nwo, 'acme/widget');
  // End-to-end /megalens:review with NO flags uses the App and never dispatches workflow
  const r = await runMain(['review'], { exec: sc.exec });
  assert.equal(r.code, 0);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.match(r.text, /Adds instead of multiplying/);
  assert.equal(r.text.includes('app:55501'), false, 'no id shown on clean completion');
  assert.equal(sc.calls.some((c) => c.args[0] === 'workflow'), false, 'never touched workflow_dispatch');
});

test('auto-pick: falls back to user GitHub runner when App is not installed and workflow is present', async () => {
  const sc = makeScenario({ appSuites: ['github-actions'], appChecks: [], workflowPresent: true });
  const det = await detectRemoteRunner({ exec: sc.exec, cwd: '/repo-a', env: {} });
  assert.equal(det.runner, 'github');
  const r = await runMain(['review'], { exec: sc.exec });
  assert.equal(r.code, 0);
  assert.match(r.text, /Review started/);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.match(r.text, /Adds instead of multiplying/);
  assert.equal(r.text.includes('gh:9001'), false, 'no id shown on clean completion');
  assert.equal(sc.calls.some((c) => c.args[0] === 'workflow'), true);
});

test('auto-pick: prints one clear setup line when neither App nor workflow is present', async () => {
  const sc = makeScenario({ orgInstallations: [], workflowPresent: false });
  const det = await detectRemoteRunner({ exec: sc.exec, cwd: '/repo-a', env: {} });
  assert.equal(det.runner, 'none');
  const r = await runMain(['review'], { exec: sc.exec });
  assert.equal(r.code, 4);
  const lines = r.text.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one setup line');
  assert.match(lines[0], new RegExp(APP_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(lines[0], /not set up for acme\/widget/);
});

test('auto-pick: spoofed check run from a non-MegaLens app slug is never accepted as MegaLens App', async () => {
  const spoof = makeAppCheckRun({ app: { slug: 'evil-app' } });
  const sc = makeScenario({ appSuites: ['evil-app'], appChecks: [spoof], workflowPresent: false });
  const det = await detectRemoteRunner({ exec: sc.exec, cwd: '/repo-a', env: {} });
  assert.equal(det.runner, 'none');
});

test('auto-pick: deep with App installed + workflow present routes to GitHub runner; App-only explains clearly', async () => {
  const deepTitle = `MegaLens deep ${B}..${H}`;
  const withWf = makeScenario({
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: null }],
    appSuites: ['megalens'],
    workflowPresent: true,
    runsAfterDispatch: [{ databaseId: 9002, displayTitle: deepTitle, createdAt: new Date().toISOString(), url: 'https://github.com/acme/widget/actions/runs/9002' }],
    downloadDoc: makeDoc({ tier: 'deep' }),
  });
  const r1 = await runMain(['review', 'deep'], { exec: withWf.exec });
  assert.equal(r1.code, 0);
  assert.match(r1.text, /MegaLens deep review: complete/);
  assert.equal(withWf.calls.some((c) => c.args[0] === 'workflow'), true);

  const appOnly = makeScenario({ orgInstallations: [{ app_slug: 'megalens', repository_selection: 'all' }] });
  const r2 = await runMain(['review', 'deep'], { exec: appOnly.exec });
  assert.equal(r2.code, 4);
  assert.match(r2.text, /GitHub App runs Standard reviews/);
});

// ---- 2. Wait loop (fake clock) + progress lines + 20-minute cap + abort ----

test('wait loop (fake clock): emits progress lines without duplicates and returns when done', async () => {
  const clk = fakeClock();
  const lines = [];
  const states = [
    { state: 'queued' },
    { state: 'queued' },
    { state: 'running' },
    ...Array.from({ length: 16 }, () => ({ state: 'running' })), // ~4 minutes at 15s polls
    { state: 'done' },
  ];
  let idx = 0;
  const res = await waitForReview({
    poll: async () => states[Math.min(idx++, states.length - 1)],
    onLine: (s) => lines.push(s.trim()),
    startedLine: 'Review started',
    queuedLine: 'Queued on GitHub...',
    runningLine: 'Running on GitHub...',
    now: clk.now,
    sleep: clk.sleep,
  });
  assert.equal(res.finished, true);
  assert.equal(res.timedOut, false);
  assert.equal(lines[0], 'Review started');
  assert.equal(lines[1], 'Queued on GitHub...');
  assert.equal(lines[2], 'Running on GitHub...');
  assert.ok(lines.includes('About 2 minutes so far'), `expected 2m line in ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('About 4 minutes so far'), `expected 4m line in ${JSON.stringify(lines)}`);
  assert.equal(lines.filter((l) => l === 'Running on GitHub...').length, 1, 'no duplicate running line');
  assert.equal(lines.filter((l) => l === 'About 2 minutes so far').length, 1, 'no duplicate 2m line');
  assert.equal(lines.includes(STILL_RUNNING_LINE), false);
});

test('wait loop (fake clock): stops at 20-minute cap and prints exact still-running line with no id', async () => {
  const clk = fakeClock();
  const lines = [];
  const res = await waitForReview({
    poll: async () => ({ state: 'running' }),
    onLine: (s) => lines.push(s.trim()),
    startedLine: 'Review started',
    runningLine: 'Running on GitHub...',
    now: clk.now,
    sleep: clk.sleep,
  });
  assert.equal(res.finished, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.aborted, false);
  assert.equal(clk.sleeps.reduce((a, b) => a + b, 0), DEFAULT_WAIT_MS, 'slept exactly up to the 20-minute cap');
  assert.equal(lines[lines.length - 1], STILL_RUNNING_LINE);
  assert.ok(lines.includes('About 2 minutes so far'));
  assert.ok(lines.includes('About 18 minutes so far'));
});

test('wait loop (fake clock): abort stops immediately and prints exact still-running line', async () => {
  const clk = fakeClock();
  const ac = new AbortController();
  const lines = [];
  let polls = 0;
  const res = await waitForReview({
    poll: async () => {
      polls += 1;
      if (polls === 2) ac.abort();
      return { state: 'running' };
    },
    onLine: (s) => lines.push(s.trim()),
    now: clk.now,
    sleep: clk.sleep,
    signal: ac.signal,
  });
  assert.equal(res.finished, false);
  assert.equal(res.aborted, true);
  assert.equal(res.timedOut, false);
  assert.equal(lines[lines.length - 1], STILL_RUNNING_LINE);
});

test('end-to-end GitHub runner wait loop (fake clock): progress lines, inline result, no id on success, id on failure', async () => {
  const clk = fakeClock();
  const sc = makeScenario({
    workflowPresent: true,
    ghRunSequence: [
      { status: 'queued' },
      ...Array.from({ length: 9 }, () => ({ status: 'in_progress' })), // >2 minutes
      { status: 'completed', conclusion: 'success' },
    ],
  });
  const r = await runMain(['review'], { exec: sc.exec, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r.code, 0);
  assert.match(r.text, /Review started\nQueued on GitHub\.\.\.\nRunning on GitHub\.\.\.\nAbout 2 minutes so far\n/);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.equal(r.text.includes('gh:9001'), false, 'no gh id on clean run');
  assert.equal(r.text.includes('rv_abc12345'), false, 'no rv id on clean run');

  // When something goes wrong (run fails), id and URL ARE shown and never called clean
  const clk2 = fakeClock();
  const badSc = makeScenario({
    workflowPresent: true,
    ghRunSequence: [{ status: 'in_progress' }, { status: 'completed', conclusion: 'failure' }],
    downloadDoc: null,
  });
  const rFail = await runMain(['review'], { exec: badSc.exec, timing: { now: clk2.now, sleep: clk2.sleep } });
  assert.equal(rFail.code, 4);
  assert.match(rFail.text, /NOT COMPLETED/);
  assert.match(rFail.text, /gh:9001/);
  assert.match(rFail.text, /actions\/runs\/9001/);
});

test('end-to-end App runner wait loop (fake clock): waits for check run, prints progress and inline result, handles partial/failed safely', async () => {
  const clk = fakeClock();
  const queuedCr = makeAppCheckRun({ status: 'queued', conclusion: null, output: { title: 'Waiting for the review machine', summary: '' } });
  const runningCr = makeAppCheckRun({ status: 'in_progress', conclusion: null, output: { title: 'Reviewing', summary: '' } });
  const doneCr = makeAppCheckRun({ status: 'completed', conclusion: 'neutral' });
  const sc = makeScenario({
    appSuites: ['megalens'],
    appChecks: [queuedCr],
    checkRunSequence: [queuedCr, runningCr, ...Array.from({ length: 8 }, () => runningCr), doneCr],
  });
  const r = await runMain(['review'], { exec: sc.exec, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r.code, 0);
  assert.match(r.text, /Following the GitHub App review/);
  assert.match(r.text, /Waiting for MegaLens review machine\.\.\./);
  assert.match(r.text, /Running on MegaLens\.\.\./);
  assert.match(r.text, /About 2 minutes so far/);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.equal(r.text.includes('app:55501'), false, 'no app id on clean completion');

  // No-credits / failed App check run is never called clean and shows id
  const noCreditsCr = makeAppCheckRun({ status: 'completed', conclusion: 'neutral', output: { title: 'No credits left', summary: 'Add credits at https://megalens.ai/app/settings/billing' } });
  const scFail = makeScenario({ appSuites: ['megalens'], appChecks: [noCreditsCr] });
  const rf = await runMain(['review'], { exec: scFail.exec });
  assert.equal(rf.code, 4);
  assert.match(rf.text, /NOT COMPLETED/);
  assert.match(rf.text, /No credits left/);
  assert.match(rf.text, /app:55501/);
  assert.equal(mapCheckState(makeAppCheckRun({ status: 'completed', conclusion: 'neutral', output: { title: 'Review incomplete, 1 finding so far' } })), 'partial');
});

// ---- 3. Cap message + no-id /megalens:result and /megalens:status ----

test('cap -> no-id /megalens:status and /megalens:result use the latest review for this repo (GitHub runner)', async () => {
  const clk = fakeClock();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcap-'));
  // Step 1: review hits 20-minute cap
  const scCap = makeScenario({ workflowPresent: true, ghRunSequence: [{ status: 'in_progress' }] });
  const r1 = await runMain(['review'], { exec: scCap.exec, stateDir, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r1.code, 0);
  assert.match(r1.text, /Still running\. Run \/megalens:result to see it\./);
  assert.equal(r1.text.includes('gh:9001'), false);

  // Verify bookmark file permissions & no secrets
  const sf = stateFilePath({ MEGALENS_STATE_DIR: stateDir });
  assert.equal(statSync(sf).mode & 0o777, 0o600);
  assert.equal(readFileSync(sf, 'utf8').includes('ghp_'), false);

  // Step 2: /megalens:status with NO id while still running
  const scStill = makeScenario({ workflowPresent: true, ghRunSequence: [{ status: 'in_progress' }] });
  const st1 = await runMain(['status'], { exec: scStill.exec, stateDir });
  assert.equal(st1.code, 0);
  assert.match(st1.text, /Still running\. Run \/megalens:result to see it\./);
  assert.equal(st1.text.includes('gh:9001'), false);

  // Step 3: /megalens:result with NO id while still running
  const resStill = await runMain(['result'], { exec: scStill.exec, stateDir });
  assert.equal(resStill.code, 4);
  assert.match(resStill.text, /Still running\. Run \/megalens:result to see it\./);

  // Step 4: once finished, /megalens:result with NO id prints findings inline with no id
  const scDone = makeScenario({ workflowPresent: true, ghRunSequence: [{ status: 'completed', conclusion: 'success' }] });
  const resDone = await runMain(['result'], { exec: scDone.exec, stateDir });
  assert.equal(resDone.code, 0);
  assert.match(resDone.text, /## MegaLens standard review: complete/);
  assert.match(resDone.text, /Adds instead of multiplying/);
  assert.equal(resDone.text.includes('gh:9001'), false);

  // Step 5: explicit id still works for advanced users
  const resExplicit = await runMain(['result', 'gh:9001'], { exec: scDone.exec, stateDir });
  assert.equal(resExplicit.code, 0);
  assert.match(resExplicit.text, /actions\/runs\/9001/);
});

test('cap -> no-id /megalens:result works for App runner and supports remote fallback without local bookmark', async () => {
  const clk = fakeClock();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlappcap-'));
  const runningCr = makeAppCheckRun({ status: 'in_progress', conclusion: null, output: { title: 'Reviewing', summary: '' } });
  const doneCr = makeAppCheckRun({ status: 'completed', conclusion: 'success', output: { title: 'No findings', summary: '' } });

  const sc1 = makeScenario({ appSuites: ['megalens'], appChecks: [runningCr], checkRunSequence: [runningCr] });
  const r1 = await runMain(['review'], { exec: sc1.exec, stateDir, timing: { now: clk.now, sleep: clk.sleep } });
  assert.equal(r1.code, 0);
  assert.match(r1.text, /Still running\. Run \/megalens:result to see it\./);

  const sc2 = makeScenario({ appSuites: ['megalens'], appChecks: [doneCr], checkRunSequence: [doneCr] });
  const res = await runMain(['result'], { exec: sc2.exec, stateDir });
  assert.equal(res.code, 0);
  assert.match(res.text, /## MegaLens standard review: complete/);
  assert.match(res.text, /No findings/);
  assert.equal(res.text.includes('app:55501'), false);

  // Fresh state dir (no local bookmark) falls back to remote lookup on GitHub
  const freshDir = mkdtempSync(path.join(tmpdir(), 'mlfresh-'));
  const resFresh = await runMain(['result'], { exec: sc2.exec, stateDir: freshDir });
  assert.equal(resFresh.code, 0);
  assert.match(resFresh.text, /## MegaLens standard review: complete/);

  // Explicit app:<id> works for advanced users; invalid app id refused
  const exp = await runMain(['status', 'app:55501'], { exec: sc2.exec, stateDir: freshDir });
  assert.equal(exp.code, 0);
  assert.match(exp.text, /Review app:55501: done/);
  const badId = await runMain(['result', 'app:bad;id'], { exec: sc2.exec, stateDir: freshDir });
  assert.equal(badId.code, 4);
  assert.match(badId.text, /not a MegaLens App review id/);
});

test('latest-review bookmarks isolate different repos and refuse symlinks', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mliso-'));
  const env = { MEGALENS_STATE_DIR: dir };
  assert.equal(saveLatestReview({ env, repoKey: '/repo-one', id: 'gh:111', runner: 'github', nwo: 'a/one' }), true);
  assert.equal(saveLatestReview({ env, repoKey: '/repo-two', id: 'app:222', runner: 'app', nwo: 'a/two' }), true);
  assert.equal(loadLatestReview({ env, repoKey: '/repo-one' }).id, 'gh:111');
  assert.equal(loadLatestReview({ env, repoKey: '/repo-two' }).id, 'app:222');
  assert.equal(loadLatestReview({ env, repoKey: '/repo-other' }), null);

  // Symlinked state dir is refused
  const trapDir = mkdtempSync(path.join(tmpdir(), 'mltrap-'));
  const target = mkdtempSync(path.join(tmpdir(), 'mlreal-'));
  symlinkSync(target, path.join(trapDir, 'plugin-state'));
  assert.equal(saveLatestReview({ env: { MEGALENS_STATE_DIR: trapDir }, repoKey: '/repo-x', id: 'gh:9', runner: 'github' }), false);
  assert.equal(existsSync(path.join(target, 'latest-reviews.json')), false);
});

test('local deep wait loop (fake clock) hits 20-minute cap, prints still-running line, and no-id result fetches it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mllocaldeep-'));
  const bin = path.join(dir, 'megalens-review');
  const stateFile = path.join(dir, 'done-flag');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'run') { process.stdout.write(JSON.stringify({ review_id: 'rv_localdeep1', state: 'running' }) + '\\n'); process.exit(0); }
if (a[0] === 'status') {
  const done = fs.existsSync(${JSON.stringify(stateFile)});
  process.stdout.write(JSON.stringify({ review_id: 'rv_localdeep1', state: done ? 'complete' : 'running', tier: 'deep' }) + '\\n');
  process.exit(0);
}
if (a[0] === 'result') {
  const out = a[a.indexOf('--out') + 1];
  fs.writeFileSync(out, JSON.stringify(${JSON.stringify(makeDoc({ review_id: 'rv_localdeep1', tier: 'deep' }))}));
  process.exit(0);
}
`);
  chmodSync(bin, 0o755);
  const clk = fakeClock();
  const r1 = await runMain(['review', 'deep', '--runner', 'local'], {
    exec: async () => bad('no gh', 127),
    stateDir: dir,
    cwd: dir,
    platform: 'linux',
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin },
    timing: { now: clk.now, sleep: clk.sleep },
  });
  assert.equal(r1.code, 0);
  assert.match(r1.text, /Review started/);
  assert.match(r1.text, /Running locally\.\.\./);
  assert.match(r1.text, /About 2 minutes so far/);
  assert.match(r1.text, /Still running\. Run \/megalens:result to see it\./);
  assert.equal(r1.text.includes('rv_localdeep1'), false);

  // Now mark it done and run /megalens:result with NO id
  writeFileSync(stateFile, '1');
  const r2 = await runMain(['result'], {
    exec: async () => bad('no gh', 127),
    stateDir: dir,
    cwd: dir,
    platform: 'linux',
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin },
  });
  assert.equal(r2.code, 0);
  assert.match(r2.text, /## MegaLens deep review: complete/);
  assert.match(r2.text, /Adds instead of multiplying/);
  assert.equal(r2.text.includes('rv_localdeep1'), false);
});

// ---- 4. README main path & secret redaction ----

test('README main path is 2 steps (install plugin, /megalens:review) with no --runner or review ids', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const mainPath = readme.split('## Advanced')[0];
  assert.ok(mainPath.length > 100, 'has a main section before Advanced');
  assert.match(mainPath, /## Quick start \(2 steps\)/);
  assert.match(mainPath, /claude --plugin-dir/);
  assert.match(mainPath, /\/megalens:review/);
  assert.equal(mainPath.includes('--runner'), false, '--runner must not appear in README main path');
  assert.equal(/gh:<|gh:\d+|rv_|app:<|app:\d+/.test(mainPath), false, 'review ids must not appear in README main path');
});

test('secrets are scrubbed from App check summaries and never printed (including stateless ghs_APPID_JWT and publisher-truncated JWT tail)', async () => {
  const jwtTok = 'ghs_123456_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRodWIiLCJleHAiOjE3MDAwMDAwMDB9.SigPayload_ABC-123';
  const pubPartial = '[redacted].eyJpc3MiOiJnaXRodWItcHViIiwiZXhwIjoxNzAwMDAwMDAxfQ.PubTailSig_XYZ-789';
  const leakyCr = makeAppCheckRun({
    output: {
      title: `1 strong finding, 1 in total (${TOKEN})`,
      summary: `Line leaks ${TOKEN} and ghp_${'A'.repeat(36)} and ${jwtTok} and ${pubPartial}`,
    },
  });
  const sc = makeScenario({ appSuites: ['megalens'], appChecks: [leakyCr] });
  const r = await runMain(['review'], { exec: sc.exec, env: { MEGALENS_TOKEN: TOKEN } });
  assert.equal(r.code, 0);
  for (const leaked of [TOKEN, 'ghp_AAAA', 'ghs_123456', 'eyJhbGci', 'eyJpc3Mi', 'SigPayload_ABC', 'PubTailSig_XYZ']) {
    assert.equal(r.text.includes(leaked), false, `must not leak ${leaked}`);
  }
  assert.equal(secretContent(`token=${jwtTok}`), 'GitHub token');
});

// ---- 5. Fix round tests (SOL.md findings 1–9) ----

test('SOL-1: App with no check on feature branch falls back to dispatch workflow when both are present', async () => {
  const sc = makeScenario({
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: null }],
    appChecks: [],
    openPrs: [],
    workflowPresent: true,
  });
  const r = await runMain(['review'], { exec: sc.exec });
  assert.equal(r.code, 0);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.equal(sc.calls.some((c) => c.args[0] === 'workflow'), true, 'dispatched workflow on demand when App had no check');
  assert.equal(r.text.includes('Open a pull request'), false, 'no spurious App error before fallback');
});

test('SOL-2: current installation & repo access via org/user APIs detects zero-check App and rejects removed/suspended App', async () => {
  // Active org installation with ZERO prior checks on HEAD or main is detected
  const zeroChecks = makeScenario({
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: null }],
    appSuites: [],
    appChecks: [],
    workflowPresent: false,
  });
  const d1 = await detectRemoteRunner({ exec: zeroChecks.exec, cwd: '/repo-a', env: {} });
  assert.equal(d1.runner, 'app');

  // Removed or suspended org installation with historical checks on HEAD + main is REJECTED and falls back to workflow
  for (const orgInstallations of [
    [],
    [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: '2026-11-20T00:00:00Z' }],
  ]) {
    const removed = makeScenario({
      orgInstallations,
      appSuites: ['megalens'],
      appChecks: [makeAppCheckRun()],
      workflowPresent: true,
    });
    const d2 = await detectRemoteRunner({ exec: removed.exec, cwd: '/repo-a', env: {} });
    assert.equal(d2.runner, 'github', 'removed/suspended App must not suppress workflow fallback');
  }

  // User installations API with repository_selection=selected checks actual repo access
  const selectedYes = makeScenario({
    userInstallations: [{ id: 22, app_slug: 'megalens', repository_selection: 'selected', suspended_at: null, account_login: 'acme' }],
    installRepos: { 22: ['acme/widget'] },
    appSuites: [],
    appChecks: [],
  });
  assert.equal((await detectRemoteRunner({ exec: selectedYes.exec, cwd: '/repo-a', env: {} })).runner, 'app');

  const selectedNo = makeScenario({
    userInstallations: [{ id: 22, app_slug: 'megalens', repository_selection: 'selected', suspended_at: null, account_login: 'acme' }],
    installRepos: { 22: ['acme/other-repo'] },
    appSuites: ['megalens'],
    appChecks: [makeAppCheckRun()],
    workflowPresent: true,
  });
  assert.equal((await detectRemoteRunner({ exec: selectedNo.exec, cwd: '/repo-a', env: {} })).runner, 'github');

  // When installation APIs return 403/404, historical check ONLY on defaultBranch never suppresses workflow fallback
  const staleHistory = makeScenario({
    headSuites: [],
    headChecks: [],
    defaultSuites: ['megalens'],
    defaultChecks: [makeAppCheckRun()],
    workflowPresent: true,
  });
  assert.equal((await detectRemoteRunner({ exec: staleHistory.exec, cwd: '/repo-a', env: {} })).runner, 'github');
});

test('SOL-3: Linux follows App -> workflow -> local order, and without local creds prints strictly 1 setup line', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mllinux-'));
  const bin = path.join(dir, 'megalens-review');
  const marker = path.join(dir, 'local-ran');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(4);\n`);
  chmodSync(bin, 0o755);

  // Linux with MEGALENS_TOKEN + working local bin MUST still pick App first
  const scApp = makeScenario({
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: null }],
    appSuites: ['megalens'],
    appChecks: [makeAppCheckRun()],
    workflowPresent: true,
  });
  const rApp = await runMain(['review'], { exec: scApp.exec, platform: 'linux', env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin } });
  assert.equal(rApp.code, 0);
  assert.equal(existsSync(marker), false, 'local engine must not run before App');

  // Linux with MEGALENS_TOKEN + working local bin MUST pick workflow before local
  const scWf = makeScenario({ appSuites: [], appChecks: [], workflowPresent: true });
  const rWf = await runMain(['review'], { exec: scWf.exec, platform: 'linux', env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin } });
  assert.equal(rWf.code, 0);
  assert.equal(existsSync(marker), false, 'local engine must not run before workflow');

  // Linux without local credentials and neither App nor workflow prints ONLY the 1 setup line
  const scNone = makeScenario({ orgInstallations: [], workflowPresent: false });
  const rNone = await runMain(['review'], { exec: scNone.exec, platform: 'linux', env: { MEGALENS_TOKEN: undefined } });
  assert.equal(rNone.code, 4);
  const lines = rNone.text.trim().split('\n');
  assert.equal(lines.length, 1, `expected 1 setup line, got: ${rNone.text}`);
  assert.match(lines[0], /not set up for acme\/widget/);
  assert.equal(rNone.text.includes('local engine'), false);
});

test('SOL-4: deadline & abort interrupt in-flight polls, result downloads, and real subprocesses promptly', async () => {
  // 4a. Overtime poll (fake clock advances past waitMs inside poll) is NOT accepted as finished
  const clk = fakeClock();
  const lines = [];
  const overtime = await waitForReview({
    poll: async () => {
      clk.advance(DEFAULT_WAIT_MS + 1000);
      return { state: 'done' };
    },
    onLine: (s) => lines.push(s.trim()),
    now: clk.now,
    sleep: clk.sleep,
  });
  assert.equal(overtime.finished, false);
  assert.equal(overtime.timedOut, true);
  assert.equal(lines[lines.length - 1], STILL_RUNNING_LINE);

  // 4b. Real-clock hanging poll is aborted immediately on signal (does not wait for poll to return)
  const ac = new AbortController();
  let pollSignalAborted = false;
  const tStart = performance.now();
  const pending = waitForReview({
    poll: (callSignal) => new Promise((resolve) => {
      callSignal.addEventListener('abort', () => { pollSignalAborted = true; }, { once: true });
      const t = setTimeout(() => resolve({ state: 'done' }), 5000);
      t.unref?.();
    }),
    waitMs: 5000,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 15);
  const aborted = await pending;
  assert.equal(aborted.finished, false);
  assert.equal(aborted.aborted, true);
  assert.equal(pollSignalAborted, true);
  assert.ok(performance.now() - tStart < 500, 'abort must not wait for hanging poll');

  // 4c. Slow result download exceeding deadline is interrupted promptly and prints still-running line
  let dlAborted = false;
  const scSlowDl = makeScenario({
    workflowPresent: true,
    ghRunSequence: [{ status: 'completed', conclusion: 'success' }],
    onDownload: (_args, opts) => new Promise((resolve) => {
      opts?.signal?.addEventListener('abort', () => { dlAborted = true; }, { once: true });
      const t = setTimeout(() => resolve(ok('')), 5000);
      t.unref?.();
    }),
  });
  const tDl = performance.now();
  const rDl = await runMain(['review'], { exec: scSlowDl.exec, timing: { waitMs: 30, pollMs: 10 } });
  assert.equal(rDl.code, 0);
  assert.equal(dlAborted, true);
  assert.match(rDl.text, /Still running\. Run \/megalens:result to see it\./);
  assert.ok(performance.now() - tDl < 1000);

  // 4e. realExec kills a long-running child promptly when AbortSignal fires
  const acExec = new AbortController();
  const tExec = performance.now();
  const pExec = realExec(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { env: { PATH: process.env.PATH }, signal: acExec.signal });
  setTimeout(() => acExec.abort(), 15);
  const rExec = await pExec;
  assert.equal(rExec.aborted, true);
  assert.ok(performance.now() - tExec < 1000, 'realExec must resolve promptly on abort');
});

test('SOL-5: no-id status/result always picks the newest review across bookmark, App check, and workflow run', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlnewest-'));
  const tOld = Date.parse('2026-11-23T10:00:00Z');
  const tNew = Date.parse('2026-11-23T10:30:00Z');

  // Saved bookmark is older gh:100; a newer App check app:55509 exists on HEAD -> must return app:55509
  saveLatestReview({ env: { MEGALENS_STATE_DIR: stateDir }, repoKey: '/repo-a', id: 'gh:100', runner: 'github', nwo: 'acme/widget', startedAt: tOld });
  const newerCr = makeAppCheckRun({
    id: 55509,
    started_at: '2026-11-23T10:30:00Z',
    output: { title: '1 strong finding, 1 in total', summary: 'Newer App finding on HEAD' },
  });
  const scNewerApp = makeScenario({ appChecks: [newerCr], checkRunSequence: [newerCr] });
  const res1 = await runMain(['result'], { exec: scNewerApp.exec, stateDir });
  assert.equal(res1.code, 0);
  assert.match(res1.text, /Newer App finding on HEAD/);

  // Empty cache: App check on HEAD is OLDER (10:00), workflow run gh:9099 is NEWER (10:30) -> must return gh:9099
  const freshDir = mkdtempSync(path.join(tmpdir(), 'mlnewest2-'));
  const olderCr = makeAppCheckRun({ id: 55501, started_at: '2026-11-23T10:00:00Z' });
  const scNewerWf = makeScenario({
    appChecks: [olderCr],
    existingRuns: [{ databaseId: 9099, displayTitle: `MegaLens deep ${B}..${H}`, createdAt: '2026-11-23T10:30:00Z', url: 'https://github.com/acme/widget/actions/runs/9099' }],
    downloadDoc: makeDoc({ tier: 'deep', findings: [{ id: 'f9', file: 'new.js', line_start: 9, line_end: 9, title: 'Newer workflow finding', claim: 'from gh:9099', priority: 'P1', strength: 'strong', found_by: ['codex-deep'] }] }),
  });
  const latest = await findLatestRemoteReview({ exec: scNewerWf.exec, cwd: '/repo-a', env: {} });
  assert.equal(latest.id, 'gh:9099');
  const res2 = await runMain(['result'], { exec: scNewerWf.exec, stateDir: freshDir });
  assert.equal(res2.code, 0);
  assert.match(res2.text, /Newer workflow finding/);

  // Saved bookmark is older app:55501 (10:00), newer workflow run gh:9099 (10:30) -> must return gh:9099
  saveLatestReview({ env: { MEGALENS_STATE_DIR: freshDir }, repoKey: '/repo-a', id: 'app:55501', runner: 'app', nwo: 'acme/widget', startedAt: tOld });
  const res3 = await runMain(['result'], { exec: scNewerWf.exec, stateDir: freshDir });
  assert.equal(res3.code, 0);
  assert.match(res3.text, /Newer workflow finding/);
  assert.equal(tNew > tOld, true);
});

test('SOL-6: explicit --base/--head range is routed to workflow when present and rejected on App-only repos', async () => {
  // App + workflow + explicit range -> routes to GitHub workflow (supports exact base..head)
  const both = makeScenario({
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: null }],
    appChecks: [makeAppCheckRun()],
    workflowPresent: true,
  });
  const r1 = await runMain(['review', '--base', 'main', '--head', 'HEAD'], { exec: both.exec });
  assert.equal(r1.code, 0);
  assert.equal(both.calls.some((c) => c.args[0] === 'workflow'), true, 'explicit range must use workflow runner');

  // App-only + explicit range -> rejected cleanly before reading any check run
  const appOnly = makeScenario({
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all', suspended_at: null }],
    appChecks: [makeAppCheckRun()],
    workflowPresent: false,
  });
  const r2 = await runMain(['review', '--base', 'main', '--head', 'HEAD'], { exec: appOnly.exec });
  assert.equal(r2.code, 4);
  assert.match(r2.text, /not custom --base\/--head ranges/);
  assert.equal(r2.text.includes('Adds instead of multiplying'), false, 'must never present a check from a different diff');

  // Forced --runner app with --base/--head -> rejected immediately
  const r3 = await runMain(['review', '--runner', 'app', '--base', 'main', '--head', 'HEAD'], { exec: both.exec });
  assert.equal(r3.code, 4);
  assert.match(r3.text, /not custom --base\/--head ranges/);
});

test('SOL-7: commands/review.md sets 10-min Bash timeout and specifies background-task continuation without restarting', () => {
  const md = readFileSync(new URL('../commands/review.md', import.meta.url), 'utf8');
  assert.match(md, /timeout:\s*600000/);
  assert.match(md, /moves the Bash command to the background/i);
  assert.match(md, /never start a second review command/i);
  assert.match(md, /completion notification/i);
  assert.match(md, /Still running\. Run \/megalens:result to see it\./);
});

test('SOL-9: successful App results strip publisher-embedded rv_ review IDs and HTML markers when showId is false', async () => {
  const pubSummary = [
    '<!-- megalens-review-summary:standard -->',
    '<!-- megalens-review-meta:{"sha":"aaaaaaa","tier":"standard","status":"complete","ts":1700000000000} -->',
    '### MegaLens static review of `aaaaaaa`',
    '',
    'Tier: `standard` · Review: `rv_pub98765`',
    '',
    '**Strong findings (1):**',
    '- **P1** `total.js:3`: Adds instead of multiplying',
  ].join('\n');
  const pubCr = makeAppCheckRun({ output: { title: '1 strong finding, 1 in total', summary: pubSummary } });
  const sc = makeScenario({ appSuites: ['megalens'], appChecks: [pubCr], checkRunSequence: [pubCr] });

  // Clean /megalens:review hides rv_pub98765 and HTML comment markers while keeping Tier + findings
  const r = await runMain(['review'], { exec: sc.exec });
  assert.equal(r.code, 0);
  assert.match(r.text, /Adds instead of multiplying/);
  assert.match(r.text, /Tier: `standard`/);
  assert.equal(r.text.includes('rv_pub98765'), false, 'publisher rv_ id must be stripped on clean App result');
  assert.equal(r.text.includes('<!-- megalens-review-'), false, 'HTML markers must be stripped');

  // Explicit /megalens:result app:55501 (showId: true) still retains rv_pub98765
  const rExplicit = await runMain(['result', 'app:55501'], { exec: sc.exec });
  assert.equal(rExplicit.code, 0);
  assert.match(rExplicit.text, /rv_pub98765/);

  // Failed/partial check run keeps rv_pub98765 for debugging
  const partialCr = makeAppCheckRun({ status: 'completed', conclusion: 'neutral', output: { title: 'Review incomplete, 1 finding so far', summary: pubSummary } });
  const scPart = makeScenario({ appSuites: ['megalens'], appChecks: [partialCr], checkRunSequence: [partialCr] });
  const rPart = await runMain(['review'], { exec: scPart.exec });
  assert.equal(rPart.code, 2);
  assert.match(rPart.text, /rv_pub98765/);
});

// ---- 6. Loop-confirm round 2 tests (LOOP-CONFIRM1.md: SOL #2, #4, #5 + NEW #1, #2, #3) ----

test('LC1-SOL2: when live installation APIs are denied and workflow exists, historical HEAD check does not suppress workflow, while live in-progress check attaches to App', async () => {
  // Completed (historical) check on HEAD + workflowPresent + live APIs denied (403) -> falls back to workflow
  const histHead = makeScenario({
    headSuites: ['megalens'],
    headChecks: [makeAppCheckRun({ status: 'completed', conclusion: 'success' })],
    workflowPresent: true,
  });
  const d1 = await detectRemoteRunner({ exec: histHead.exec, cwd: '/repo-a', env: {} });
  assert.equal(d1.runner, 'github', 'historical completed HEAD check must not suppress workflow fallback');

  // Actively running check on HEAD + workflowPresent + live APIs denied -> attaches to App to prevent double-billing
  const activeHead = makeScenario({
    headSuites: ['megalens'],
    headChecks: [makeAppCheckRun({ status: 'in_progress', conclusion: null })],
    workflowPresent: true,
  });
  const d2 = await detectRemoteRunner({ exec: activeHead.exec, cwd: '/repo-a', env: {} });
  assert.equal(d2.runner, 'app');
  assert.equal(d2.appSource, 'head-active-check');
});

test('LC1-SOL4: SIGTERM-ignoring child is killed by SIGKILL fallback and parent exits promptly (realExec & local runBin)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mlsigkill-'));
  const pidFile = path.join(dir, 'child.pid');
  const ac = new AbortController();
  const childPromise = realExec(
    process.execPath,
    ['-e', `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
    { cwd: dir, env: { PATH: process.env.PATH }, signal: ac.signal },
  );
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) {
    try { pid = Number(readFileSync(pidFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.ok(pid > 0, 'child wrote its pid');
  ac.abort();
  const res = await childPromise;
  assert.equal(res.aborted, true);
  await new Promise((r) => setTimeout(r, 350));
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  assert.equal(alive, false, 'SIGTERM-ignoring child must be terminated by SIGKILL fallback');

  // Parent process exits promptly instead of hanging for the child's 1500ms timer
  const script = `
    import { realExec } from ${JSON.stringify(new URL('../scripts/lib/gh-runner.mjs', import.meta.url).href)};
    const ac = new AbortController();
    const p = realExec(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 1500);'], { env: { PATH: process.env.PATH }, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    if (!r.aborted) process.exit(2);
  `;
  const t0 = performance.now();
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2500 });
  const parentMs = performance.now() - t0;
  assert.ok(parentMs < 900, `parent should exit promptly after SIGKILL, took ${Math.round(parentMs)}ms`);

  // Local engine (runBin) also SIGKILLs a SIGTERM-ignoring binary on abort
  const bin = path.join(dir, 'stubborn-engine');
  const binPidFile = path.join(dir, 'bin.pid');
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(${JSON.stringify(binPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  chmodSync(bin, 0o755);
  const ac2 = new AbortController();
  const pLocal = runMain(['review', 'double', '--runner', 'local'], {
    flags: { double: true },
    exec: async () => bad('no gh', 127),
    stateDir: dir,
    cwd: dir,
    platform: 'linux',
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin },
    timing: { waitMs: 5000, cancelGraceMs: 150 },
    signal: ac2.signal,
  });
  let binPid = 0;
  for (let i = 0; i < 200 && !binPid; i++) {
    try { binPid = Number(readFileSync(binPidFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.ok(binPid > 0, 'stubborn engine wrote its pid');
  ac2.abort();
  const rLocal = await pLocal;
  assert.equal(rLocal.code, 4);
  assert.match(rLocal.text, /CANCELLED/);
  await new Promise((r) => setTimeout(r, 350));
  let binAlive = true;
  try { process.kill(binPid, 0); } catch (e) { binAlive = e.code === 'EPERM'; }
  if (binAlive) { try { process.kill(binPid, 'SIGKILL'); } catch {} }
  assert.equal(binAlive, false, 'SIGTERM-ignoring local engine must be terminated by SIGKILL fallback');
});

test('LC1-SOL5: equal-second runs break ties by ID, and findLatestRemoteReview discovers newer App checks on PR heads / default branch', async () => {
  const ts = Date.parse('2026-11-23T10:00:00Z');
  // Equal-second workflow runs prefer higher databaseId
  assert.equal(
    pickNewerReview(
      { id: 'gh:800', runner: 'github', nwo: 'acme/widget', startedAt: ts },
      { id: 'gh:801', runner: 'github', nwo: 'acme/widget', startedAt: ts },
    ).id,
    'gh:801',
  );
  // Equal-second App checks prefer higher check run id
  assert.equal(
    pickNewerReview(
      { id: 'app:700', runner: 'app', nwo: 'acme/widget', startedAt: ts },
      { id: 'app:701', runner: 'app', nwo: 'acme/widget', startedAt: ts },
    ).id,
    'app:701',
  );

  // Newer App check on another PR's head SHA (different from local HEAD) beats an older workflow run
  const otherHead = 'c'.repeat(40);
  const exec = async (cmd, args) => {
    if (cmd === 'git') return ok(`${H}\n`);
    if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } }));
    if (args[0] === 'run') return ok(JSON.stringify([{ databaseId: 801, createdAt: '2026-11-23T10:00:00Z' }]));
    if (args[0] === 'api' && args.includes('repos/acme/widget/pulls')) return ok(JSON.stringify([otherHead]));
    if (args[0] === 'api' && args.some((a) => a === `repos/acme/widget/commits/${otherHead}/check-runs`)) {
      return ok(JSON.stringify({ check_runs: [makeAppCheckRun({ id: 702, started_at: '2026-11-23T11:00:00Z' })] }));
    }
    if (args[0] === 'api' && args.some((a) => a.endsWith('/check-runs'))) return ok(JSON.stringify({ check_runs: [] }));
    return bad(`unexpected: ${cmd} ${args.join(' ')}`);
  };
  const latest = await findLatestRemoteReview({ exec, cwd: '/repo-a', env: {} });
  assert.equal(latest.id, 'app:702');
});

test('LC1-NEW1: App+workflow repo NEVER dispatches a second billable workflow when App check is delayed on PR, default branch, or inconclusive PR lookup', async () => {
  // 1a. Open PR with delayed App check arriving at 9 seconds -> waits, picks up App check, ZERO workflow dispatch
  let clock = 0;
  let dispatched = false;
  const delayedCheck = makeAppCheckRun({ id: 701, started_at: '2026-11-23T10:30:00Z' });
  const makeDualExec = ({ delayCheck = 9000, openPr = true, branch = 'feature', pullsFail = false, onRemoteDefault = false } = {}) => async (cmd, args) => {
    if (cmd === 'git') {
      if (args.includes('--show-toplevel')) return ok('/repo-a\n');
      if (args[0] === 'rev-parse') return ok(`${H}\n`);
      if (args[0] === 'merge-base') return ok(`${B}\n`);
      if (args[0] === 'status') return ok('');
      if (args[0] === 'branch') return ok(`${branch}\n`);
    }
    if (args[0] === '--version' || args[0] === 'auth') return ok('');
    if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } }));
    if (args[0] === 'secret') return ok('[{"name":"MEGALENS_TOKEN"}]');
    if (args[0] === 'api') {
      if (args.includes('orgs/acme/installations')) return ok('[{"id":10,"app_slug":"megalens","repository_selection":"all"}]');
      if (args.some((a) => a.includes('/contents/'))) return ok('file\n');
      if (args.some((a) => a.includes('/branches-where-head'))) return ok(JSON.stringify(onRemoteDefault ? ['main'] : [branch]));
      if (args.some((a) => a.includes('/compare/'))) return ok('diverged');
      if (args.some((a) => a.includes('/pulls'))) return pullsFail ? bad('HTTP 500') : ok(JSON.stringify(openPr ? [12] : []));
      if (args.some((a) => a.endsWith('/check-runs'))) return ok(JSON.stringify({ check_runs: clock >= delayCheck ? [delayedCheck] : [] }));
      if (args.some((a) => a.includes('/commits/'))) return ok(`${H}\n`);
    }
    if (args[0] === 'workflow' && args[1] === 'run') { dispatched = true; return ok(''); }
    if (args[0] === 'run' && args[1] === 'list') return ok('[]');
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };

  const rDelayed = await runMain(['review'], {
    exec: makeDualExec({ delayCheck: 9000, openPr: true }),
    timing: { now: () => clock, sleep: async (ms) => { clock += ms; }, sleepMs: 2000 },
  });
  assert.equal(rDelayed.code, 0);
  assert.equal(dispatched, false, 'must NEVER dispatch workflow while App check is still arriving');
  assert.match(rDelayed.text, /## MegaLens standard review: complete/);
  assert.ok(clock >= 9000 && clock <= 12000);

  // 1b. Open PR where App check NEVER appears within grace window -> still ZERO workflow dispatch, clear message
  clock = 0; dispatched = false;
  const rNever = await runMain(['review'], {
    exec: makeDualExec({ delayCheck: Infinity, openPr: true }),
    timing: { now: () => clock, sleep: async (ms) => { clock += ms; }, sleepMs: 2000, appearWaitMs: 10000 },
  });
  assert.equal(rNever.code, 4);
  assert.equal(dispatched, false, 'must NEVER double-dispatch after appear window expires on open PR');
  assert.match(rNever.text, /not charged twice/);

  // 1c. Detached HEAD on remote default branch -> fails closed, ZERO workflow dispatch
  clock = 0; dispatched = false;
  const rDetachedMain = await runMain(['review'], {
    exec: makeDualExec({ delayCheck: Infinity, openPr: false, branch: '', onRemoteDefault: true }),
    timing: { now: () => clock, sleep: async (ms) => { clock += ms; }, sleepMs: 2000, appearWaitMs: 6000 },
  });
  assert.equal(rDetachedMain.code, 4);
  assert.equal(dispatched, false, 'detached HEAD on default branch must never double-dispatch');

  // 1d. Failed /pulls lookup -> fails closed, ZERO workflow dispatch
  clock = 0; dispatched = false;
  const rPullErr = await runMain(['review'], {
    exec: makeDualExec({ delayCheck: Infinity, openPr: false, pullsFail: true }),
    timing: { now: () => clock, sleep: async (ms) => { clock += ms; }, sleepMs: 2000, appearWaitMs: 6000 },
  });
  assert.equal(rPullErr.code, 4);
  assert.equal(dispatched, false, 'inconclusive PR check must fail closed and never double-dispatch');
});

test('LC1-NEW2: interrupting workflow dispatch reconciles against GitHub and never claims GitHub did not start it', async () => {
  const pre = { nwo: 'acme/widget', defaultBranch: 'main', baseSha: B, headSha: H };
  const title = `MegaLens standard ${B}..${H}`;

  // 2a. Abort during dispatch when GitHub ALREADY accepted it and reconciliation finds the new run -> returns run id & bookmarks it
  const acFound = new AbortController();
  let listsFound = 0;
  let accepted = false;
  const execFound = async (cmd, args, opts) => {
    if (args[0] === 'run' && args[1] === 'list') {
      listsFound += 1;
      assert.equal(opts?.signal?.aborted, false, 'reconciliation must use a fresh non-aborted signal');
      return ok(JSON.stringify(accepted ? [{ databaseId: 9123, displayTitle: title, createdAt: '2026-11-23T10:00:00Z', url: 'https://github.com/acme/widget/actions/runs/9123' }] : []));
    }
    if (args[0] === 'workflow' && args[1] === 'run') {
      accepted = true;
      acFound.abort();
      return { code: 4, stdout: '', stderr: '', aborted: true };
    }
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const started = await startRun({ exec: execFound, cwd: '/repo-a', env: {}, tier: 'standard', pre, signal: acFound.signal });
  assert.equal(started.id, 'gh:9123');
  assert.equal(started.aborted, true);
  assert.equal(listsFound, 2, 'must run reconciliation lookup after aborted dispatch');

  // End-to-end runnerReview saves bookmark and prints Still running line so /megalens:result retrieves it
  const acE2e = new AbortController();
  let e2eAccepted = false;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlrec-'));
  const execE2e = async (cmd, args) => {
    if (cmd === 'git') {
      if (args.includes('--show-toplevel')) return ok('/repo-a\n');
      if (args[0] === 'rev-parse') return ok(`${H}\n`);
      if (args[0] === 'merge-base') return ok(`${B}\n`);
      if (args[0] === 'status') return ok('');
      if (args[0] === 'branch') return ok('feature\n');
    }
    if (args[0] === '--version' || args[0] === 'auth') return ok('');
    if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } }));
    if (args[0] === 'secret') return ok('[{"name":"MEGALENS_TOKEN"}]');
    if (args[0] === 'api' && args.some((a) => a.includes('/contents/'))) return ok('file\n');
    if (args[0] === 'api' && args.some((a) => a.includes('/commits/'))) return ok(`${H}\n`);
    if (args[0] === 'run' && args[1] === 'list') {
      return ok(JSON.stringify(e2eAccepted ? [{ databaseId: 9123, displayTitle: title, createdAt: '2026-11-23T10:00:00Z', url: 'https://github.com/acme/widget/actions/runs/9123' }] : []));
    }
    if (args[0] === 'workflow' && args[1] === 'run') {
      e2eAccepted = true;
      acE2e.abort();
      return { code: 4, stdout: '', stderr: '', aborted: true };
    }
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  let savedRec = null;
  const rr = await runnerReview({ exec: execE2e, cwd: '/repo-a', env: { MEGALENS_STATE_DIR: stateDir }, tier: 'standard', signal: acE2e.signal, saveLatest: (rec) => { savedRec = rec; } });
  assert.equal(rr.code, 0);
  assert.equal(rr.aborted, true);
  assert.equal(savedRec?.id, 'gh:9123', 'reconciled run must be bookmarked for /megalens:result');
  assert.match(rr.text, /Still running\. Run \/megalens:result to see it\./);

  // 2b. Abort during dispatch when reconciliation finds NO run yet -> warns do NOT start another (NEVER says "GitHub did not start")
  const acMiss = new AbortController();
  let listsMiss = 0;
  const execMiss = async (cmd, args) => {
    if (args[0] === 'run' && args[1] === 'list') { listsMiss += 1; return ok('[]'); }
    if (args[0] === 'workflow' && args[1] === 'run') { acMiss.abort(); return { code: 4, stdout: '', stderr: '', aborted: true }; }
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  await assert.rejects(
    () => startRun({ exec: execMiss, cwd: '/repo-a', env: {}, tier: 'standard', pre, signal: acMiss.signal }),
    (e) => {
      assert.match(e.message, /do NOT start another one/);
      assert.match(e.message, /actions\/workflows\/megalens-dispatch\.yml/);
      assert.equal(/GitHub did not start the workflow/i.test(e.message), false);
      return true;
    },
  );
  assert.equal(listsMiss, 2, 'must attempt reconciliation even when no run appears yet');

  // 2c. Ambiguous transport error (non-4xx) also reconciles and warns do NOT start another
  const execNet = async (cmd, args) => {
    if (args[0] === 'run' && args[1] === 'list') return ok('[]');
    if (args[0] === 'workflow' && args[1] === 'run') return bad('read tcp: connection reset by peer', 1);
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  await assert.rejects(
    () => startRun({ exec: execNet, cwd: '/repo-a', env: {}, tier: 'standard', pre }),
    /do NOT start another one/,
  );
});

// ---- 7. Loop-confirm round 3 tests (LOOP-CONFIRM2.md: NEW #1, SOL #4, SOL #5, LC1-NEW1) ----

test('LC2-NEW1: foreground Double cancel and timeout wait for engine SIGTERM finalization (gateway complete + workspace cleanup) before printing CANCELLED', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mlgrace-'));
  const wsDir = path.join(dir, 'workspace-snapshot');
  const callsFile = path.join(dir, 'gateway-calls.log');
  const readyFile = path.join(dir, 'ready');
  const bin = path.join(dir, 'finalizing-engine');
  // Mirrors real engine-v2 shutdown: catches SIGTERM, waits 600ms on GET /reviews/:id, posts /complete {outcome:"cancelled"}, removes workspace, then exits.
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const ws = ${JSON.stringify(wsDir)};
const calls = ${JSON.stringify(callsFile)};
const ready = ${JSON.stringify(readyFile)};
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(ws + '/source.js', 'export const x = 1;\\n');
fs.appendFileSync(calls, 'POST /api/v2/reviews\\n');
fs.writeFileSync(ready, '1');
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  fs.appendFileSync(calls, 'GET /api/v2/reviews/rv_grace001\\n');
  setTimeout(() => {
    fs.appendFileSync(calls, 'POST /api/v2/reviews/rv_grace001/complete\\n{"outcome":"cancelled"}\\n');
    fs.rmSync(ws, { recursive: true, force: true });
    process.exit(4);
  }, 600);
});
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);

  // 1a. User abort (default cancelGraceMs — no override): must NOT SIGKILL at 150ms; waits for /complete + workspace removal before returning.
  const ac = new AbortController();
  const pCancel = runMain(['review', 'double', '--runner', 'local'], {
    flags: { double: true },
    exec: async () => bad('no gh', 127),
    stateDir: dir,
    cwd: dir,
    platform: 'linux',
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin },
    timing: { waitMs: 5000 },
    signal: ac.signal,
  });
  for (let i = 0; i < 200 && !existsSync(readyFile); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(existsSync(readyFile), true, 'engine started and created workspace');
  ac.abort();
  const rCancel = await pCancel;
  assert.equal(rCancel.code, 4);
  assert.match(rCancel.text, /## MegaLens double review: CANCELLED/);
  assert.equal(rCancel.text.includes('force-stopped'), false, 'graceful finalization must not say force-stopped');
  const callsAfter = readFileSync(callsFile, 'utf8').trim().split('\n');
  assert.deepEqual(callsAfter, [
    'POST /api/v2/reviews',
    'GET /api/v2/reviews/rv_grace001',
    'POST /api/v2/reviews/rv_grace001/complete',
    '{"outcome":"cancelled"}',
  ], 'gateway review must be closed as cancelled BEFORE main returns CANCELLED');
  assert.equal(existsSync(wsDir), false, 'workspace snapshot must be removed BEFORE main returns CANCELLED');

  // 1b. Wait-cap timeout also lets engine-v2 finalize cleanly before returning NOT COMPLETED.
  writeFileSync(callsFile, '');
  try { execFileSync('rm', ['-f', readyFile]); } catch {}
  const rTimeout = await runMain(['review', 'double', '--runner', 'local'], {
    flags: { double: true },
    exec: async () => bad('no gh', 127),
    stateDir: dir,
    cwd: dir,
    platform: 'linux',
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin },
    timing: { waitMs: 120 },
  });
  assert.equal(rTimeout.code, 4);
  assert.match(rTimeout.text, /## MegaLens double review: NOT COMPLETED/);
  assert.equal(existsSync(wsDir), false, 'workspace snapshot must be removed on wait-cap timeout');
  assert.match(readFileSync(callsFile, 'utf8'), /POST \/api\/v2\/reviews\/rv_grace001\/complete/);

  // 1c. Stubborn engine ignoring SIGTERM past cancelGraceMs is force-stopped and warns honestly.
  const stubborn = path.join(dir, 'stubborn-warn');
  writeFileSync(stubborn, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n');
  chmodSync(stubborn, 0o755);
  const acStub = new AbortController();
  const pStub = runMain(['review', 'double', '--runner', 'local'], {
    flags: { double: true },
    exec: async () => bad('no gh', 127),
    stateDir: dir,
    cwd: dir,
    platform: 'linux',
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: stubborn },
    timing: { waitMs: 5000, cancelGraceMs: 120 },
    signal: acStub.signal,
  });
  setTimeout(() => acStub.abort(), 40);
  const rStub = await pStub;
  assert.equal(rStub.code, 4);
  assert.match(rStub.text, /force-stopped/);
});

test('LC2-SOL4: appReview bounds initial check-runs lookup by waitMs and never accepts an overtime check as complete', async () => {
  let checkSignalAborted = false;
  const tStart = performance.now();
  const res = await appReview({
    cwd: '/repo-a',
    env: {},
    preRepo: { nwo: 'acme/widget', defaultBranch: 'main' },
    waitMs: 15,
    now: () => performance.now(),
    exec: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return ok(`${H}\n`);
      if (cmd === 'git' && args[0] === 'status') return ok('');
      if (args.some((a) => a.endsWith('/check-runs'))) {
        return await new Promise((resolve) => {
          opts?.signal?.addEventListener('abort', () => { checkSignalAborted = true; }, { once: true });
          const t = setTimeout(() => resolve(ok(JSON.stringify({ check_runs: [makeAppCheckRun({ id: 777, started_at: '2026-11-23T10:00:00Z' })] }))), 200);
          t.unref?.();
        });
      }
      if (args.some((a) => a === `repos/acme/widget/commits/${H}`)) return ok(`${H}\n`);
      return bad(`unexpected ${cmd} ${args.join(' ')}`);
    },
  });
  const elapsed = performance.now() - tStart;
  assert.equal(res.code, 4);
  assert.equal(res.timedOut, true);
  assert.equal(checkSignalAborted, true, 'overtime initial check-runs call must be aborted');
  assert.equal(res.text.includes('## MegaLens standard review: complete'), false, 'must never accept overtime check as complete');
  assert.ok(elapsed < 180, `appReview should time out promptly around waitMs, took ${Math.round(elapsed)}ms`);
});

test('LC2-NEW1-BWH: appReview fails closed (zero workflow dispatch) when branches-where-head or check-runs lookup fails', async () => {
  for (const mode of ['bwh-fail', 'checks-fail']) {
    let dispatches = 0;
    const exec = async (cmd, args) => {
      if (cmd === 'git') {
        if (args.includes('--show-toplevel')) return ok('/repo-a\n');
        if (args[0] === 'rev-parse') return ok(`${H}\n`);
        if (args[0] === 'merge-base') return ok(`${B}\n`);
        if (args[0] === 'status') return ok('');
        if (args[0] === 'branch') return ok('feature\n');
      }
      if (args[0] === '--version' || args[0] === 'auth') return ok('');
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'secret') return ok('[{"name":"MEGALENS_TOKEN"}]');
      if (args[0] === 'api') {
        if (args.includes('orgs/acme/installations')) return ok('[{"id":10,"app_slug":"megalens","repository_selection":"all"}]');
        if (args.some((a) => a.includes('/contents/'))) return ok('file\n');
        if (args.some((a) => a.includes('/branches-where-head'))) return mode === 'bwh-fail' ? bad('HTTP 502') : ok('["feature"]');
        if (args.some((a) => a.includes('/compare/'))) return ok('diverged');
        if (args.some((a) => a.includes('/pulls'))) return ok('[]');
        if (args.some((a) => a.endsWith('/check-runs'))) return mode === 'checks-fail' ? bad('HTTP 502') : ok('{"check_runs":[]}');
        if (args.some((a) => a.includes('/commits/'))) return ok(`${H}\n`);
      }
      if (args[0] === 'workflow' && args[1] === 'run') { dispatches += 1; return ok(''); }
      if (args[0] === 'run' && args[1] === 'list') return ok('[]');
      return bad(`unexpected ${cmd} ${args.join(' ')}`);
    };
    let clock = 0;
    const r = await runMain(['review'], {
      exec,
      timing: { now: () => clock, sleep: async (ms) => { clock += ms; }, sleepMs: 2000, appearWaitMs: 4000 },
    });
    assert.equal(r.code, 4, `${mode}: must fail closed`);
    assert.equal(dispatches, 0, `${mode}: must NEVER dispatch a second billable workflow when check/branch state is inconclusive`);
    assert.match(r.text, /not charged twice/);
  }
});

test('LC2-SOL5: findLatestRemoteReview checks paginated PRs and default-branch commits, and pickNewerReview handles same-second ms skew', async () => {
  // 5a. Newer App check on PR #12 (beyond the old per_page=5 limit) beats an older workflow run
  const prHeads = Array.from({ length: 12 }, (_, i) => i.toString(16).repeat(40));
  const targetPrSha = prHeads[11];
  let sawPagination = false;
  const execPr12 = async (cmd, args) => {
    if (cmd === 'git') return ok(`${H}\n`);
    if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } }));
    if (args[0] === 'run') return ok(JSON.stringify([{ databaseId: 23, createdAt: '2026-11-23T10:00:00Z' }]));
    if (args[0] === 'api' && args.includes('repos/acme/widget/pulls')) {
      if (args.includes('--paginate')) sawPagination = true;
      return ok(JSON.stringify(prHeads));
    }
    if (args[0] === 'api' && args.includes('repos/acme/widget/commits')) return ok(JSON.stringify([]));
    if (args[0] === 'api' && args.some((a) => a === `repos/acme/widget/commits/${targetPrSha}/check-runs`)) {
      return ok(JSON.stringify({ check_runs: [makeAppCheckRun({ id: 25, started_at: '2026-11-23T11:00:00Z' })] }));
    }
    if (args[0] === 'api' && args.some((a) => a.endsWith('/check-runs'))) return ok(JSON.stringify({ check_runs: [] }));
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const latestPr = await findLatestRemoteReview({ exec: execPr12, cwd: '/repo-a', env: {} });
  assert.equal(sawPagination, true, 'must paginate pull requests');
  assert.equal(latestPr.id, 'app:25');

  // 5b. Newer App check on a recent default-branch commit behind tip is discovered via repos/{nwo}/commits
  const tipSha = 'd'.repeat(40);
  const prevMainSha = 'e'.repeat(40);
  const execCommits = async (cmd, args) => {
    if (cmd === 'git') return ok(`${H}\n`);
    if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } }));
    if (args[0] === 'run') return ok(JSON.stringify([{ databaseId: 23, createdAt: '2026-11-23T10:00:00Z' }]));
    if (args[0] === 'api' && args.includes('repos/acme/widget/pulls')) return ok(JSON.stringify([]));
    if (args[0] === 'api' && args.includes('repos/acme/widget/commits')) return ok(JSON.stringify([tipSha, prevMainSha]));
    if (args[0] === 'api' && args.some((a) => a === `repos/acme/widget/commits/${prevMainSha}/check-runs`)) {
      return ok(JSON.stringify({ check_runs: [makeAppCheckRun({ id: 29, started_at: '2026-11-23T11:05:00Z' })] }));
    }
    if (args[0] === 'api' && args.some((a) => a.endsWith('/check-runs'))) return ok(JSON.stringify({ check_runs: [] }));
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const latestCommit = await findLatestRemoteReview({ exec: execCommits, cwd: '/repo-a', env: {} });
  assert.equal(latestCommit.id, 'app:29');

  // 5c. Sub-second local Date.now() ms on older bookmark does not beat newer GitHub run in the same second
  const isoSec = Date.parse('2026-11-23T10:00:00Z');
  assert.equal(
    pickNewerReview(
      { id: 'gh:800', runner: 'github', nwo: 'acme/widget', startedAt: isoSec + 850 },
      { id: 'gh:801', runner: 'github', nwo: 'acme/widget', startedAt: isoSec },
    ).id,
    'gh:801',
  );
  assert.equal(
    pickNewerReview(
      { id: 'app:700', runner: 'app', nwo: 'acme/widget', startedAt: isoSec + 900 },
      { id: 'app:701', runner: 'app', nwo: 'acme/widget', startedAt: isoSec },
    ).id,
    'app:701',
  );
});

test('LC3-NEW1: both default GitHub routes reject real untracked files hidden by Git config', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mluntracked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', args, {
    cwd: dir, input, encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
  git(['init', '-q', '-b', 'main']);
  const tree = git(['mktree'], '');
  const base = git(['commit-tree', tree, '-m', 'base']);
  const head = git(['commit-tree', tree, '-p', base, '-m', 'head']);
  git(['update-ref', 'refs/heads/main', base]);
  git(['update-ref', 'refs/heads/feature', head]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/feature']);
  git(['config', 'status.showUntrackedFiles', 'no']);
  writeFileSync(path.join(dir, 'new-source.js'), 'export const answer = 42;\n');
  assert.equal(git(['status', '--porcelain']), '');
  for (const runner of ['github', 'app']) {
    const sc = makeScenario({
      workflowPresent: true,
      orgInstallations: runner === 'app' ? [{ app_slug: 'megalens', repository_selection: 'all' }] : [],
      appChecks: [makeAppCheckRun()],
    });
    const exec = (cmd, args, opts) => {
      if (cmd === 'git') return realExec(cmd, args, opts);
      if (args.includes(`repos/acme/widget/commits/${head}`)) return ok(head);
      if (args[0] === 'run' && args[1] === 'list') {
        return ok(JSON.stringify(sc.calls.some(({ args: a }) => a[0] === 'workflow') ?
          [{ databaseId: 9001, displayTitle: `MegaLens standard ${base}..${head}` }] : []));
      }
      return sc.exec(cmd, args, opts);
    };
    for (const flags of [[], ['--runner', runner]]) {
      const result = await runMain(['review', ...flags], { exec, cwd: dir, stateDir: dir });
      assert.match(result.text, /You have uncommitted changes/, runner);
      assert.equal(result.code, 4);
    }
    assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow' || args.some((a) => a.endsWith('/check-runs'))), false);
  }
});

test('LC3-SOL1: App-only work with no webhook trigger explains exactly how to start a review', async () => {
  const sc = makeScenario({ orgInstallations: [{ app_slug: 'megalens', repository_selection: 'all' }], openPrs: [] });
  const r = await runMain(['review'], { exec: sc.exec });
  assert.equal(r.code, 4);
  assert.match(r.text, /No review was started.*Open a pull request/s);
  assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow'), false);
});

test('LC3-SOL2 and LC1-NEW1: inaccessible installation APIs cannot dispatch over an App review still being published', async () => {
  const sc = makeScenario({ workflowPresent: true, openPrs: [12] });
  const clock = fakeClock();
  const exec = (cmd, args, opts) => {
    if (args.some((a) => a.endsWith('/check-runs')) && clock.sleeps.length) {
      return ok(JSON.stringify({ check_runs: [makeAppCheckRun()] }));
    }
    return sc.exec(cmd, args, opts);
  };
  const r = await runMain(['review'], { exec, timing: { ...clock, appearWaitMs: 20 } });
  assert.equal(r.code, 0);
  assert.match(r.text, /MegaLens standard review: complete/);
  assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow'), false);
});

test('LC3-LC1-NEW1: a default-branch push remains eligible for an App review after the branch tip moves', async () => {
  const sc = makeScenario({
    orgInstallations: [{ app_slug: 'megalens', repository_selection: 'all' }],
    branch: 'feature', workflowPresent: true, openPrs: [],
  });
  const clock = fakeClock();
  const exec = (cmd, args, opts) => {
    if (args.some((a) => a.includes('/compare/'))) return ok('ahead');
    return sc.exec(cmd, args, opts);
  };
  const r = await runMain(['review'], { exec, timing: { ...clock, appearWaitMs: 15 } });
  assert.equal(r.code, 4);
  assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow'), false);
});

test('LC3-SOL4: auto-detection spends the same wait budget as the selected runner', async () => {
  const sc = makeScenario({ workflowPresent: true });
  const clock = fakeClock();
  const exec = (cmd, args, opts) => {
    if (args.includes('orgs/acme/installations')) {
      clock.advance(101);
      return ok('[]');
    }
    return sc.exec(cmd, args, opts);
  };
  const r = await runMain(['review'], { exec, timing: { ...clock, waitMs: 100 } });
  assert.equal(r.code, 4);
  assert.match(r.text, /Timed out before starting/);
  assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow'), false);
});

test('LC3-SOL4: interrupt cancels the repository lookup before an explicit runner starts', async () => {
  const sc = makeScenario({ workflowPresent: true });
  const ac = new AbortController();
  let lookupSignal;
  const exec = (cmd, args, opts) => {
    if (args.includes('--show-toplevel')) {
      lookupSignal = opts.signal;
      ac.abort();
      return new Promise(() => {});
    }
    return sc.exec(cmd, args, opts);
  };
  const r = await runMain(['review', '--runner', 'github'], { exec, signal: ac.signal });
  assert.equal(lookupSignal?.aborted, true);
  assert.equal(r.code, 4);
  assert.match(r.text, /Interrupted before starting/);
});

test('LC3-SOL5: no-id status discovers App reviews on later pages of GitHub refs and check runs', async () => {
  const older = makeAppCheckRun({ id: 810, started_at: '2026-11-23T10:00:00Z' });
  const newer = makeAppCheckRun({ id: 811, started_at: '2026-11-23T10:30:00Z' });
  const otherHead = 'd'.repeat(40);
  const sc = makeScenario();
  const viewed = [];
  const exec = (cmd, args, opts) => {
    if (args.includes('repos/acme/widget/pulls')) {
      return ok(args.includes('--paginate') ? `["${H}"]\n["${otherHead}"]` : `["${H}"]`);
    }
    if (args.includes(`repos/acme/widget/commits/${otherHead}/check-runs`)) {
      return ok(args.includes('--paginate')
        ? `${JSON.stringify({ check_runs: [older] })}\n${JSON.stringify({ check_runs: [newer] })}`
        : JSON.stringify({ check_runs: [older] }));
    }
    const check = args.find((a) => a.startsWith('repos/acme/widget/check-runs/'));
    if (check) {
      viewed.push(check.split('/').at(-1));
      return ok(JSON.stringify(check.endsWith('/811') ? newer : older));
    }
    return sc.exec(cmd, args, opts);
  };
  const status = await runMain(['status'], { exec });
  const result = await runMain(['result'], { exec });
  assert.equal(status.code, 0);
  assert.equal(result.code, 0);
  assert.match(status.text, /Finished/);
  assert.match(result.text, /MegaLens standard review: complete/);
  assert.deepEqual(viewed, ['811', '811']);
});

test('LC3-SOL5: completing an older local review after a newer one preserves the newest bookmark', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mloutoforder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { env: { MEGALENS_STATE_DIR: dir }, repoKey: dir, runner: 'local' };
  assert.equal(saveLatestReview({ ...state, id: 'rv_newer001', startedAt: 2000 }), true);
  saveLatestReview({ ...state, id: 'rv_older001', startedAt: 1000 });
  assert.equal(loadLatestReview(state).id, 'rv_newer001');
});

test('LC3-LC1-NEW3: a Local Standard review can be retrieved by a new command after the wait limit', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mlstdresume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-engine');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'run') process.exit(4);
setTimeout(() => fs.writeFileSync(args[args.indexOf('--out') + 1], ${JSON.stringify(JSON.stringify(makeDoc()))}), 220);
`, { mode: 0o700 });
  const options = { cwd: dir, stateDir: dir, exec: async () => bad('no gh', 127), platform: 'linux' };
  const r = await runMain(['review', '--runner', 'local'], {
    ...options, timing: { waitMs: 60 }, env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin },
  });
  assert.equal(r.code, 0);
  assert.match(r.text, /Still running/);
  const deadline = Date.now() + 3000;
  let result;
  do {
    result = await runMain(['result'], options);
    if (result.code === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(result.code, 0);
  assert.match(result.text, /Adds instead of multiplying/);
});

test('LC3-LC2-NEW1: stopping the Local Standard wait lets the gateway and snapshot finish normally', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mlstdgateway-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-engine');
  const active = path.join(dir, 'gateway-active');
  const snapshot = path.join(dir, 'snapshot');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const snapshot = ${JSON.stringify(snapshot)};
const active = ${JSON.stringify(active)};
process.on('SIGTERM', () => process.exit(4));
fs.writeFileSync(snapshot, 'snapshot');
fs.writeFileSync(active, 'gateway active');
setTimeout(() => {
  fs.unlinkSync(active);
  fs.unlinkSync(snapshot);
  fs.writeFileSync(args[args.indexOf('--out') + 1], ${JSON.stringify(JSON.stringify(makeDoc()))});
}, 500);
`, { mode: 0o700 });
  const options = { cwd: dir, stateDir: dir, exec: async () => bad('no gh', 127), platform: 'linux' };
  const ac = new AbortController();
  const request = runMain(['review', '--runner', 'local'], {
    ...options, signal: ac.signal, timing: { cancelGraceMs: 150 },
    env: { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin },
  });
  const deadline = Date.now() + 3000;
  while (!existsSync(active) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(active), true);
  ac.abort();
  const stopped = await request;
  const status = await runMain(['status'], options);
  while (existsSync(active) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(existsSync(active), false);
  assert.equal(existsSync(snapshot), false);
  assert.equal(stopped.code, 0);
  assert.match(stopped.text, /Still running/);
  assert.match(status.text, /running/i);
});

test('LC3-LC1-NEW3: Local Standard survives exit of the initiating CLI', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mlstdcli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-engine');
  const release = path.join(dir, 'release');
  writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexit 127\n', { mode: 0o700 });
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const timeout = setTimeout(() => process.exit(4), 5000);
const ready = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(ready);
  clearTimeout(timeout);
  fs.writeFileSync(args[args.indexOf('--out') + 1], ${JSON.stringify(JSON.stringify(makeDoc()))});
}, 10);
`, { mode: 0o700 });
  const env = { PATH: `${dir}${path.delimiter}${process.env.PATH}`, HOME: dir, MEGALENS_STATE_DIR: dir };
  const cli = (args, credentials = {}) => execFileSync(process.execPath, [new URL('../scripts/engine.mjs', import.meta.url).pathname, ...args], {
    cwd: dir, env: { ...env, ...credentials }, encoding: 'utf8', timeout: 3000,
  });
  const started = cli(['review', '--runner', 'local', '--no-wait'], { MEGALENS_TOKEN: TOKEN, MEGALENS_REVIEW_BIN: bin });
  assert.match(started, /Still running/);
  writeFileSync(release, '');
  const deadline = Date.now() + 3000;
  while (!/is complete/.test(cli(['status'])) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(cli(['result']), /Adds instead of multiplying/);
});
