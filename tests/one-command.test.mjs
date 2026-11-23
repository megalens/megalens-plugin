// Tests for the ONE-COMMAND plugin UX:
//   1. Runner auto-pick (GitHub App -> user's GitHub runner -> one clear setup line)
//   2. Wait loop with fake clock (progress lines, inline completion with no id, 20-min cap, abort)
//   3. No-id /megalens:result and /megalens:status (saved bookmark + remote fallback + multi-repo isolation)
//   4. README main path = 2 steps (no --runner or ids in main path)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectRemoteRunner, appReview, appStatus, appResult, mapCheckState, CHECK_NAME, APP_INSTALL_URL, WORKFLOW_FILE } from '../scripts/lib/gh-runner.mjs';
import { waitForReview, DEFAULT_WAIT_MS, STILL_RUNNING_LINE } from '../scripts/lib/wait-loop.mjs';
import { saveLatestReview, loadLatestReview, stateFilePath } from '../scripts/lib/latest-review.mjs';
import { main } from '../scripts/engine.mjs';

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
  appSuites = [],
  appChecks = [],
  workflowPresent = false,
  checkRunSequence = null,
  ghRunSequence = null,
  downloadDoc = makeDoc(),
  openPrs = [12],
  runsAfterDispatch = null,
} = {}) {
  const calls = [];
  let dispatched = false;
  let checkIdx = 0;
  let runIdx = 0;
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
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
    if (k.startsWith('gh api') && args.some((a) => a.includes('/check-suites'))) return ok(JSON.stringify(appSuites));
    if (k.startsWith('gh api') && args.some((a) => a.includes('/check-runs/'))) {
      const seq = checkRunSequence ?? [makeAppCheckRun()];
      const cr = seq[Math.min(checkIdx++, seq.length - 1)];
      return ok(JSON.stringify(cr));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/check-runs'))) {
      if (args.includes('--jq')) return ok(JSON.stringify(appChecks.map((c) => ({ name: c.name, slug: c.app?.slug }))));
      return ok(JSON.stringify({ check_runs: appChecks }));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/contents/'))) return workflowPresent ? ok('file\n') : bad('HTTP 404');
    if (k.startsWith('gh api') && args.some((a) => a.includes('/pulls'))) return ok(JSON.stringify(openPrs));
    if (k.startsWith('gh api') && args.some((a) => a.includes('/commits/'))) return ok(`${H}\n`);
    if (k.startsWith('gh workflow run')) { dispatched = true; return ok(''); }
    if (k.startsWith('gh run list')) {
      const title = `MegaLens standard ${B}..${H}`;
      const rows = runsAfterDispatch ?? [{ databaseId: 9001, displayTitle: title, createdAt: new Date().toISOString(), url: `https://github.com/${nwo}/actions/runs/9001` }];
      return ok(JSON.stringify(dispatched ? rows : []));
    }
    if (k.startsWith('gh run view')) {
      const seq = ghRunSequence ?? [{ status: 'completed', conclusion: 'success' }];
      const cur = seq[Math.min(runIdx++, seq.length - 1)];
      return ok(JSON.stringify({ status: cur.status, conclusion: cur.conclusion ?? '', url: `https://github.com/${nwo}/actions/runs/9001`, workflowName: 'MegaLens Dispatch', displayTitle: 't' }));
    }
    if (k.startsWith('gh run download')) {
      const dir = args[args.indexOf('-D') + 1];
      if (!downloadDoc) return bad('no artifact');
      writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(downloadDoc));
      return ok('');
    }
    return bad(`unexpected: ${k} ${args.join(' ')}`, 99);
  };
  return { exec, calls };
}

async function runMain(argv, { exec, stateDir, cwd = '/repo-a', platform = 'darwin', env = {}, timing = {}, signal = null } = {}) {
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), 'mlone-'));
  let text = '';
  const code = await main(argv, {
    platform,
    exec,
    cwd,
    env: { PATH: process.env.PATH, HOME: dir, MEGALENS_STATE_DIR: dir, GH_TOKEN: 'ghp_testtoken1234567890', ...env },
    out: (s) => { text += s; },
    err: () => {},
    flags: { runnerTiming: { sleepMs: 1, tries: 2, ...timing } },
    signal,
  });
  return { code, text, stateDir: dir };
}

// ---- 1. Runner auto-pick ----

test('auto-pick: prefers our review machine via GitHub App when installed, even if workflow is also present', async () => {
  const sc = makeScenario({ appSuites: ['megalens'], appChecks: [makeAppCheckRun()], workflowPresent: true });
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
  const sc = makeScenario({ appSuites: [], appChecks: [], workflowPresent: false });
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
    appSuites: ['megalens'],
    workflowPresent: true,
    runsAfterDispatch: [{ databaseId: 9002, displayTitle: deepTitle, createdAt: new Date().toISOString(), url: 'https://github.com/acme/widget/actions/runs/9002' }],
    downloadDoc: makeDoc({ tier: 'deep' }),
  });
  const r1 = await runMain(['review', 'deep'], { exec: withWf.exec });
  assert.equal(r1.code, 0);
  assert.match(r1.text, /MegaLens deep review: complete/);
  assert.equal(withWf.calls.some((c) => c.args[0] === 'workflow'), true);

  const appOnly = makeScenario({ appSuites: ['megalens'], workflowPresent: false });
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
  assert.match(r.text, /Review started/);
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

test('secrets are scrubbed from App check summaries and never printed', async () => {
  const leakyCr = makeAppCheckRun({
    output: {
      title: `1 strong finding, 1 in total (${TOKEN})`,
      summary: `Line leaks ${TOKEN} and ghp_${'A'.repeat(36)}`,
    },
  });
  const sc = makeScenario({ appSuites: ['megalens'], appChecks: [leakyCr] });
  const r = await runMain(['review'], { exec: sc.exec, env: { MEGALENS_TOKEN: TOKEN } });
  assert.equal(r.code, 0);
  assert.equal(r.text.includes(TOKEN), false);
  assert.equal(r.text.includes('ghp_AAAA'), false);
});
