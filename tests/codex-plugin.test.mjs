// Tests for the MegaLens Codex plugin (CLI + desktop app):
//   1. Feature flag default OFF (CODEX_PLUGIN_ENABLED=false; flag off = live behaviour unchanged; marketplace gated NOT_AVAILABLE)
//   2. One-command review logic, runner order (APP_PATH_ENABLED=false), wait loop, no-id status/result, forced upload failure
//   3. Strict ID validation, Codex output adaptation (without mangling findings), secret scrubbing
//   4. Self-contained bundled runtime (works isolated from unrelated repos; never executes repo-relative decoy scripts)
//   5. Persisted preview opt-in across CLI/desktop restarts (and explicit env override / symlink refusal)
//   6. Codex installer safety (skills, CLI prompts, marketplace, TOML-aware --with-oauth-mcp, backups, symlinks, idempotency)
//   7. Manifest, prompt, skill, README, and live codex-cli 0.170.0 plugin/marketplace validation
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_PLUGIN_ENABLED,
  CODEX_PLUGIN_OFF_MESSAGE,
  PREVIEW_OPT_IN_FILENAME,
  hasPersistedPreviewOptIn,
  isCodexPluginEnabled,
} from '../codex/scripts/flags.mjs';
import {
  CODEX_WORKFLOW_SETUP_NOTE,
  adaptCodexOutput,
  isValidCodexReviewId,
  main as codexMain,
} from '../codex/scripts/codex-review.mjs';
import {
  hasExistingMegalensMcp,
  installCodex,
  parseArgs as parseInstallArgs,
} from '../codex/scripts/install-codex.mjs';
import { hasTomlPath } from '../codex/scripts/toml-inspect.mjs';
import { main as claudeMain } from '../scripts/engine.mjs';
import { APP_PATH_ENABLED, CHECK_NAME } from '../scripts/lib/gh-runner.mjs';
import { checkToml } from '../scripts/hosts/toml-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_DIR = path.join(ROOT, 'codex');
const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TOKEN = 'ml_SECRETTOKEN1234567890';
const SETUP_LINE = 'Install the MegaLens GitHub App or add the workflow: https://megalens.ai/app/start';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'err', code = 1) => ({ code, stdout: '', stderr });
const walk = (d, o = []) => {
  if (!existsSync(d)) return o;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, o);
    else o.push(p);
  }
  return o;
};

function hasCodexCli() {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Query `codex app-server --stdio` for a sequence of JSON-RPC requests and return responses keyed by id. */
function queryCodexAppServer({ env, cwd, requests }) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const responses = new Map();
    const wantedIds = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));
    let buf = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`codex app-server timed out waiting for ids: ${[...wantedIds].join(',')}`));
    }, 10_000);

    const done = (err) => {
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      if (err) reject(err);
      else resolve(responses);
    };

    child.on('error', done);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && wantedIds.has(msg.id)) {
          responses.set(msg.id, msg);
          if (msg.id === 1) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
            for (const req of requests) {
              if (req.id !== 1) child.stdin.write(`${JSON.stringify(req)}\n`);
            }
          }
          if (responses.size === wantedIds.size) {
            done(null);
            return;
          }
        }
      }
    });

    const init = requests.find((r) => r.id === 1);
    child.stdin.write(`${JSON.stringify(init)}\n`);
  });
}

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
    review_id: 'rv_codex12345',
    tier: 'standard',
    status: 'complete',
    passes: [{ name: 'codex-standard', model: 'gpt-6.2-sol', effort: 'medium', status: 'ok' }],
    findings: [{
      id: 'f1',
      file: 'cart.js',
      line_start: 12,
      line_end: 12,
      title: 'Off-by-one tax discount',
      claim: 'Applies discount twice when coupon is empty',
      failure_scenario: 'Empty coupon string reduces subtotal by 10%',
      priority: 'P1',
      strength: 'strong',
      found_by: ['codex-standard'],
    }],
    ...extra,
  };
}

function makeScenario({
  repoRoot = '/repo-codex',
  nwo = 'acme/codex-app',
  defaultBranch = 'main',
  workflowPresent = false,
  orgInstallations = null,
  appChecks = [],
  dirty = false,
  pushed = true,
  ghRunSequence = null,
  downloadDoc = makeDoc(),
  existingRuns = [],
  runsAfterDispatch = null,
} = {}) {
  const calls = [];
  let dispatched = false;
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
    if (k.startsWith('git status')) return ok(dirty ? ' M cart.js\n' : '');
    if (k.startsWith('git branch')) return ok('feat/codex\n');
    if (k.startsWith('gh secret')) return ok(JSON.stringify([{ name: 'MEGALENS_TOKEN' }]));
    if (k.startsWith('gh api') && args.some((a) => /^orgs\/[^/]+\/installations$/.test(a))) {
      return orgInstallations === null ? bad('HTTP 403') : ok(JSON.stringify(orgInstallations));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/check-runs'))) {
      return ok(JSON.stringify({ check_runs: appChecks }));
    }
    if (k.startsWith('gh api') && args.some((a) => a.includes('/contents/'))) return workflowPresent ? ok('file\n') : bad('HTTP 404');
    if (k.startsWith('gh api') && args.some((a) => a.includes('/commits/'))) return pushed ? ok(`${H}\n`) : bad('HTTP 404');
    if (k.startsWith('gh workflow run')) { dispatched = true; return ok(''); }
    if (k.startsWith('gh run list')) {
      const title = `MegaLens standard ${B}..${H}`;
      const rows = runsAfterDispatch ?? [{ databaseId: 8001, displayTitle: title, createdAt: new Date().toISOString(), url: `https://github.com/${nwo}/actions/runs/8001` }];
      return ok(JSON.stringify(dispatched ? [...rows, ...existingRuns] : existingRuns));
    }
    if (k.startsWith('gh run view')) {
      const seq = ghRunSequence ?? [{ status: 'completed', conclusion: 'success' }];
      const cur = seq[Math.min(runIdx++, seq.length - 1)];
      const runIdArg = args[2] || '8001';
      return ok(JSON.stringify({ status: cur.status, conclusion: cur.conclusion ?? '', url: `https://github.com/${nwo}/actions/runs/${runIdArg}`, workflowName: 'MegaLens Dispatch', displayTitle: 't' }));
    }
    if (k.startsWith('gh run download')) {
      const dir = args[args.indexOf('-D') + 1];
      if (!downloadDoc) return bad('no valid artifacts found to download');
      writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(downloadDoc));
      return ok('');
    }
    return bad(`unexpected: ${k} ${args.join(' ')}`, 99);
  };
  return { exec, calls };
}

async function runCodex(argv, { exec, stateDir, cwd = '/repo-codex', env = {}, timing = {}, signal = null, flags = { codexPlugin: true } } = {}) {
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), 'mlcodex-'));
  let text = '';
  let errText = '';
  const code = await codexMain(argv, {
    exec,
    cwd,
    env: { PATH: process.env.PATH, HOME: dir, MEGALENS_STATE_DIR: dir, GH_TOKEN: 'ghp_testtoken1234567890', ...env },
    out: (s) => { text += s; },
    err: (s) => { errText += s; },
    flags: { ...flags, runnerTiming: { sleepMs: 1, tries: 2, ...timing } },
    signal,
  });
  return { code, text, errText, stateDir: dir };
}

// ---- 1. Feature flag default OFF (including native marketplace gate) ----

test('flags: CODEX_PLUGIN_ENABLED and APP_PATH_ENABLED are both OFF by default; repo ships no opt-in marker', () => {
  assert.equal(CODEX_PLUGIN_ENABLED, false);
  assert.equal(APP_PATH_ENABLED, false);
  assert.equal(existsSync(path.join(CODEX_DIR, PREVIEW_OPT_IN_FILENAME)), false);
  assert.equal(isCodexPluginEnabled({}), false);
  assert.equal(isCodexPluginEnabled({ MEGALENS_CODEX_PLUGIN: '0' }), false);
  assert.equal(isCodexPluginEnabled({ MEGALENS_CODEX_PLUGIN: 'false' }), false);
  assert.equal(isCodexPluginEnabled({ MEGALENS_CODEX_PLUGIN: 'off' }), false);
  assert.equal(isCodexPluginEnabled({ MEGALENS_CODEX_PLUGIN: '1' }), true);
  assert.equal(isCodexPluginEnabled({ MEGALENS_CODEX_PLUGIN: 'true' }), true);
  assert.equal(isCodexPluginEnabled({ MEGALENS_CODEX_PLUGIN: 'ON' }), true);
  assert.equal(isCodexPluginEnabled({ MEGALENS_CODEX_PLUGIN: '1' }, { codexPlugin: false }), false);
  assert.equal(isCodexPluginEnabled({}, { codexPlugin: true }), true);
});

test('flag OFF: codex-review refuses every subcommand with zero subprocesses; Claude engine unchanged', async (t) => {
  const sc = makeScenario({ workflowPresent: true });
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-off-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  for (const argv of [['review'], ['review', 'deep'], ['status'], ['result'], ['--help']]) {
    const r = await runCodex(argv, { exec: sc.exec, stateDir, flags: {} });
    assert.equal(r.code, 4);
    assert.equal(r.text, `${CODEX_PLUGIN_OFF_MESSAGE}\n`);
  }
  assert.deepEqual(sc.calls, [], 'flag OFF must execute zero gh/git commands');

  // Existing Claude Code plugin behavior is completely unchanged when CODEX_PLUGIN_ENABLED is false
  let claudeOut = '';
  const claudeCode = await claudeMain(['review'], {
    exec: sc.exec,
    cwd: '/repo-codex',
    env: { PATH: process.env.PATH, HOME: stateDir, MEGALENS_STATE_DIR: stateDir, GH_TOKEN: 'ghp_testtoken1234567890' },
    out: (s) => { claudeOut += s; },
    err: () => {},
    flags: { runnerTiming: { sleepMs: 1, tries: 2 } },
  });
  assert.equal(claudeCode, 0);
  assert.match(claudeOut, /Off-by-one tax discount/);
});

test('flag OFF: install-codex writes zero files and creates zero backups', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-instoff-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const res = installCodex({ home, codexHome: path.join(home, '.codex') }, { env: {}, flags: {} });
  assert.equal(res.code, 4);
  assert.equal(res.report[0], CODEX_PLUGIN_OFF_MESSAGE);
  assert.deepEqual(walk(home), []);
});

test('FIX 6 (flag OFF): native marketplace policy is NOT_AVAILABLE and codex-cli refuses activation', async (t) => {
  const mp = JSON.parse(readFileSync(path.join(CODEX_DIR, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(mp.plugins[0].policy.installation, 'NOT_AVAILABLE');

  if (!hasCodexCli()) return;
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-mp-off-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const codexHome = path.join(home, '.codex');
  const proj = path.join(tmp, 'proj');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome };

  const addMp = spawnSync('codex', ['plugin', 'marketplace', 'add', CODEX_DIR], { env, encoding: 'utf8' });
  assert.equal(addMp.status, 0, addMp.stderr);
  const addPlug = spawnSync('codex', ['plugin', 'add', 'megalens@megalens', '--json'], { env, encoding: 'utf8' });
  assert.notEqual(addPlug.status, 0, 'native plugin add must fail while CODEX_PLUGIN_ENABLED=false');
  assert.match(`${addPlug.stdout}\n${addPlug.stderr}`, /not available for install/i);

  const res = await queryCodexAppServer({
    env,
    cwd: proj,
    requests: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1.0' }, capabilities: { experimentalApi: true } } },
      { jsonrpc: '2.0', id: 2, method: 'skills/list', params: { cwds: [proj] } },
    ],
  });
  const skills = (res.get(2)?.result?.data?.[0]?.skills ?? []).filter((s) => /megalens/i.test(s.name));
  assert.deepEqual(skills, [], 'zero MegaLens skills may be exposed when flag is OFF');
});

// ---- 2. One-command review, runner order, explicit workflow guidance, forced upload failure ----

test('codex review: auto-pick uses GitHub workflow when present (skipping disabled App), waits, shows findings inline without ID', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-wf-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sc = makeScenario({
    workflowPresent: true,
    orgInstallations: [{ id: 10, app_slug: 'megalens', repository_selection: 'all' }],
    appChecks: [{ id: 55501, name: CHECK_NAME, status: 'completed', conclusion: 'success', app: { slug: 'megalens' } }],
  });
  const r = await runCodex(['review'], { exec: sc.exec, stateDir });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Review started/);
  assert.match(r.text, /## MegaLens standard review: complete/);
  assert.match(r.text, /Off-by-one tax discount/);
  assert.equal(r.text.includes('gh:8001'), false);
  assert.equal(r.text.includes('/megalens:'), false);
  assert.equal(sc.calls.filter(({ args }) => args[0] === 'workflow' && args[1] === 'run').length, 1);
  // Zero App installation/check API calls while APP_PATH_ENABLED is false
  assert.equal(sc.calls.some(({ args }) => args.some((a) => /installations|check-runs/.test(a))), false);
});

test('FIX 4: missing workflow keeps runner order, never falls back to local engine, and makes Actions setup & blocked no-copy status explicit', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-nosetup-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sc = makeScenario({ workflowPresent: false });
  const r = await runCodex(['review'], {
    exec: sc.exec,
    stateDir,
    env: { MEGALENS_TOKEN: TOKEN },
  });
  assert.equal(r.code, 4);
  assert.equal(r.text, `${SETUP_LINE}\n${CODEX_WORKFLOW_SETUP_NOTE}\n`);
  assert.match(r.text, /APP_PATH_ENABLED=false/);
  assert.match(r.text, /gh auth login/);
  assert.match(r.text, /\.github\/workflows\/megalens-dispatch\.yml/);
  assert.match(r.text, /--runner github/);
  assert.match(r.text, /gh secret set MEGALENS_TOKEN/);
  assert.match(r.text, /zero-copy GitHub setup is blocked/i);
  assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow'), false);
});

test('FIX 5: forced artifact upload failure reports NOT COMPLETED with run URL and never claims clean', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-uploadfail-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  // Case A: upload-artifact step failed after scan -> workflow run concludes failure and has no artifact
  const failRun = makeScenario({
    workflowPresent: true,
    ghRunSequence: [{ status: 'completed', conclusion: 'failure' }],
    downloadDoc: null,
  });
  const rFail = await runCodex(['review'], { exec: failRun.exec, stateDir });
  assert.equal(rFail.code, 4);
  assert.match(rFail.text, /## MegaLens review: NOT COMPLETED/);
  assert.match(rFail.text, /not a clean review/i);
  assert.match(rFail.text, /Review id: gh:8001/);
  assert.match(rFail.text, /https:\/\/github\.com\/acme\/codex-app\/actions\/runs\/8001/);

  // Case B: completed/success run whose artifact is missing -> result command exits 4 and never claims clean
  const missingArtifact = makeScenario({
    workflowPresent: true,
    ghRunSequence: [{ status: 'completed', conclusion: 'success' }],
    downloadDoc: null,
  });
  const rRes = await runCodex(['result', 'gh:8001'], { exec: missingArtifact.exec, stateDir });
  assert.equal(rRes.code, 4);
  assert.match(rRes.text, /## MegaLens review: NOT COMPLETED/);
  assert.match(rRes.text, /no valid artifacts found to download/i);
  assert.match(rRes.text, /https:\/\/github\.com\/acme\/codex-app\/actions\/runs\/8001/);

  // Codex bundled workflow template includes transient upload retry while keeping pinned action SHAs
  const codexWf = readFileSync(path.join(CODEX_DIR, 'runtime', 'templates', 'megalens-dispatch.yml'), 'utf8');
  assert.match(codexWf, /id:\s*upload-findings/);
  assert.match(codexWf, /continue-on-error:\s*true/);
  assert.match(codexWf, /steps\.upload-findings\.outcome == 'failure'/);
  assert.match(codexWf, /overwrite:\s*true/);
  assert.match(codexWf, /megalens\/review-action@950eb5f1eeff21008fcf585587b88fc83546cdcf/);
  assert.match(codexWf, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
});

test('codex review deep: dispatches deep tier and shows findings inline', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-deep-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sc = makeScenario({
    workflowPresent: true,
    runsAfterDispatch: [{ databaseId: 8002, displayTitle: `MegaLens deep ${B}..${H}`, createdAt: new Date().toISOString() }],
    downloadDoc: makeDoc({ tier: 'deep' }),
  });
  const r = await runCodex(['review', 'deep'], { exec: sc.exec, stateDir });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /## MegaLens deep review: complete/);
  assert.ok(sc.calls.some(({ args }) => args.includes('tier=deep')));
});

test('codex review: App path and Double tier are both disabled before any GitHub call', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-disabled-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sc = makeScenario({ workflowPresent: true });

  for (const argv of [['review', '--runner', 'app'], ['status', 'app:55501'], ['result', 'app:55501']]) {
    const r = await runCodex(argv, { exec: sc.exec, stateDir });
    assert.equal(r.code, 4);
    assert.match(r.text, /GitHub App path is disabled/);
    assert.equal(r.text.includes('/megalens:'), false);
  }
  const dbl = await runCodex(['review', 'double'], { exec: sc.exec, stateDir });
  assert.equal(dbl.code, 4);
  assert.match(dbl.text, /Double tier is not available/);
  assert.deepEqual(sc.calls, []);
});

test('codex review: wait loop hits 20-min cap with Codex-adapted result hint and no-id result retrieves findings', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-wait-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const clk = fakeClock();
  const sc = makeScenario({
    workflowPresent: true,
    ghRunSequence: [
      { status: 'queued' },
      { status: 'in_progress' },
      { status: 'in_progress' },
    ],
  });
  const r = await runCodex(['review'], {
    exec: sc.exec,
    stateDir,
    timing: {
      now: clk.now,
      sleep: clk.sleep,
      waitMs: 5 * 60_000,
      pollMs: 2 * 60_000,
      progressMs: 2 * 60_000,
    },
  });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Queued on GitHub\.\.\./);
  assert.match(r.text, /Running on GitHub\.\.\./);
  assert.match(r.text, /About 2 minutes so far/);
  assert.match(r.text, /Still running\. Run \$megalens-result to see it\./);
  assert.equal(r.text.includes('/megalens:result'), false);

  // Now run no-id status and result once completed
  const scDone = makeScenario({
    workflowPresent: true,
    existingRuns: [{ databaseId: 8001, displayTitle: `MegaLens standard ${B}..${H}`, createdAt: new Date().toISOString() }],
    ghRunSequence: [{ status: 'completed', conclusion: 'success' }],
  });
  const st = await runCodex(['status'], { exec: scDone.exec, stateDir });
  assert.equal(st.code, 0, st.text);
  assert.match(st.text, /Finished\. Run \$megalens-result to see it\./);

  const res = await runCodex(['result'], { exec: scDone.exec, stateDir });
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /Off-by-one tax discount/);
});

test('codex review: dirty worktree stops without dispatch; unpushed commit asks NEEDS THE USER OK without pushing', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-guard-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const dirtySc = makeScenario({ workflowPresent: true, dirty: true });
  const rDirty = await runCodex(['review'], { exec: dirtySc.exec, stateDir });
  assert.equal(rDirty.code, 4);
  assert.match(rDirty.text, /uncommitted changes/i);
  assert.equal(dirtySc.calls.some(({ args }) => args[0] === 'workflow'), false);

  const unpushedSc = makeScenario({ workflowPresent: true, pushed: false });
  const rUnpushed = await runCodex(['review'], { exec: unpushedSc.exec, stateDir });
  assert.equal(rUnpushed.code, 4);
  assert.match(rUnpushed.text, /NEEDS THE USER'S OK/);
  assert.match(rUnpushed.text, /run \$megalens-review again/);
  assert.equal(unpushedSc.calls.some(({ cmd, args }) => cmd === 'git' && args[0] === 'push'), false);
});

test('codex status/result: no history suggests $megalens-review; malformed IDs rejected before any call', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-ids-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sc = makeScenario({ existingRuns: [] });

  assert.equal(isValidCodexReviewId('gh:9001'), true);
  assert.equal(isValidCodexReviewId('app:55501'), true);
  assert.equal(isValidCodexReviewId('rv_abc12345'), true);
  for (const badId of ['gh:123;whoami', 'gh:0', 'app:bad', 'rv_x', 'rv_a;b', '--help', '$(id)', '']) {
    assert.equal(isValidCodexReviewId(badId), false, badId);
    const r = await runCodex(['status', badId], { exec: sc.exec, stateDir });
    assert.equal(r.code, 4);
  }
  assert.deepEqual(sc.calls, [], 'bad IDs must never invoke gh/git');

  const none = await runCodex(['status'], { exec: sc.exec, stateDir });
  assert.equal(none.code, 4);
  assert.match(none.text, /Run \$megalens-review to start one\./);
});

test('FIX 2 + output adaptation: uses working `npx megalens-mcp setup` (not `setup codex`), preserves findings, scrubs secrets', async (t) => {
  const findingLine = '- **P1** `docs/help.md:4`: Example says `/megalens:review` instead of `$megalens-review`';
  assert.equal(adaptCodexOutput(findingLine), findingLine);
  assert.equal(
    adaptCodexOutput('Still running. Run /megalens:result to see it.'),
    'Still running. Run $megalens-result to see it.',
  );
  const adaptedAuth = adaptCodexOutput('Set MEGALENS_TOKEN and restart Claude Code. Without a repo or without the engine installed, /megalens:megalens-review still works with a token.');
  assert.match(adaptedAuth, /restart Codex.*npx megalens-mcp setup`/);
  assert.equal(adaptedAuth.includes('setup codex'), false);

  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-scrub-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sc = makeScenario({
    workflowPresent: true,
    downloadDoc: makeDoc({
      findings: [{
        id: 'f1',
        file: 'a.js',
        line_start: 1,
        line_end: 1,
        title: `Leaked ${TOKEN} and ghp_abcdefghijklmnopqrstuvwxyz123456`,
        claim: 'bad',
        priority: 'P1',
        strength: 'strong',
        found_by: ['codex-standard'],
      }],
    }),
  });
  const r = await runCodex(['review'], { exec: sc.exec, stateDir, env: { MEGALENS_TOKEN: TOKEN } });
  assert.equal(r.code, 0);
  assert.equal(r.text.includes(TOKEN), false);
  assert.equal(r.text.includes('ghp_abcdefghijklmnopqrstuvwxyz123456'), false);
  assert.match(r.text, /\[redacted\]/);
});

test('codex CLI subprocess: default OFF exits 4; MEGALENS_CODEX_PLUGIN=1 --help exits 0 with `npx megalens-mcp setup`', () => {
  const script = path.join(CODEX_DIR, 'scripts', 'codex-review.mjs');
  let offCode = 0;
  let offOut = '';
  try {
    offOut = execFileSync(process.execPath, [script, '--help'], {
      env: { PATH: process.env.PATH, HOME: tmpdir() },
      encoding: 'utf8',
    });
  } catch (e) {
    offCode = e.status;
    offOut = e.stdout || '';
  }
  assert.equal(offCode, 4);
  assert.match(offOut, /CODEX_PLUGIN_ENABLED=false/);

  const helpOut = execFileSync(process.execPath, [script, '--help'], {
    env: { PATH: process.env.PATH, HOME: tmpdir(), MEGALENS_CODEX_PLUGIN: '1' },
    encoding: 'utf8',
  });
  assert.match(helpOut, /npx megalens-mcp setup\b/);
  assert.equal(helpOut.includes('setup codex'), false);
  assert.match(helpOut, /GitHub App path enabled: false/);
});

// ---- 3. FIX 1: Bundled runtime isolation, parity, decoy attack defense, and real codex-cli plugin/read ----

test('FIX 1: codex/runtime matches canonical scripts byte-for-byte and has zero external imports', () => {
  const syncedFiles = [
    'scripts/engine.mjs',
    'scripts/hosts/toml-check.mjs',
    'scripts/lib/engine-core.mjs',
    'scripts/lib/gh-runner.mjs',
    'scripts/lib/latest-review.mjs',
    'scripts/lib/local-standard.mjs',
    'scripts/lib/safety.mjs',
    'scripts/lib/wait-loop.mjs',
  ];
  for (const rel of syncedFiles) {
    assert.equal(
      readFileSync(path.join(CODEX_DIR, 'runtime', rel), 'utf8'),
      readFileSync(path.join(ROOT, rel), 'utf8'),
      `codex/runtime/${rel} drifted from ${rel}`,
    );
  }
  for (const f of readdirSync(path.join(CODEX_DIR, 'scripts'))) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(path.join(CODEX_DIR, 'scripts', f), 'utf8');
    assert.equal(/\bfrom\s+['"]\.\.\/\.\.\//.test(src), false, `${f} must not import outside codex/`);
  }
});

test('FIX 1: isolated cached plugin runs from unrelated repo containing a decoy codex/scripts/codex-review.mjs without executing it', async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-isolated-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Copy ONLY codex/ into a completely isolated folder (no parent scripts/ or package.json)
  const isolatedPkg = path.join(tmp, 'cached-plugin');
  cpSync(CODEX_DIR, isolatedPkg, { recursive: true });

  // Create an unrelated customer repository with a malicious decoy script at codex/scripts/codex-review.mjs
  const customerRepo = path.join(tmp, 'customer-repo');
  const decoyDir = path.join(customerRepo, 'codex', 'scripts');
  mkdirSync(decoyDir, { recursive: true });
  const pwnedFile = path.join(customerRepo, 'PWNED');
  writeFileSync(
    path.join(decoyDir, 'codex-review.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pwnedFile)}, 'pwned'); process.exit(99);\n`,
  );

  // Resolve runner strictly from the skill's own directory (<SKILL_DIR>/../../scripts/codex-review.mjs)
  const skillDir = path.join(isolatedPkg, 'skills', 'megalens-review');
  const skillMd = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.ok(skillMd.includes('<SKILL_DIR>/../../scripts/codex-review.mjs'));
  assert.equal(skillMd.includes('"codex/scripts/codex-review.mjs"'), false);
  const resolvedRunner = path.resolve(skillDir, '..', '..', 'scripts', 'codex-review.mjs');

  // Flag OFF in isolated package: exits 4 cleanly (no MODULE_NOT_FOUND, decoy never runs)
  const offRun = spawnSync(process.execPath, [resolvedRunner, 'review'], {
    cwd: customerRepo,
    env: { PATH: process.env.PATH, HOME: tmp },
    encoding: 'utf8',
  });
  assert.equal(offRun.status, 4, offRun.stderr);
  assert.match(offRun.stdout, /CODEX_PLUGIN_ENABLED=false/);
  assert.equal(existsSync(pwnedFile), false, 'customer repo decoy script must never execute');

  // Flag ON in isolated package: --help exits 0 with zero external imports needed
  const onRun = spawnSync(process.execPath, [resolvedRunner, '--help'], {
    cwd: customerRepo,
    env: { PATH: process.env.PATH, HOME: tmp, MEGALENS_CODEX_PLUGIN: '1' },
    encoding: 'utf8',
  });
  assert.equal(onRun.status, 0, onRun.stderr);
  assert.match(onRun.stdout, /npx megalens-mcp setup\b/);
  assert.equal(existsSync(pwnedFile), false, 'customer repo decoy script must never execute');

  // If codex CLI is available, verify real native marketplace preview (with AVAILABLE flipped in temp copy ONLY)
  // exposes MCP server `megalens`, interface `MegaLens`, and cached skills whose relative runner executes cleanly
  if (!hasCodexCli()) return;
  const mpPath = path.join(isolatedPkg, '.agents', 'plugins', 'marketplace.json');
  const mp = JSON.parse(readFileSync(mpPath, 'utf8'));
  mp.plugins[0].policy.installation = 'AVAILABLE';
  writeFileSync(mpPath, JSON.stringify(mp, null, 2));

  const home = path.join(tmp, 'home');
  const codexHome = path.join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const cliEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome };
  assert.equal(spawnSync('codex', ['plugin', 'marketplace', 'add', isolatedPkg], { env: cliEnv }).status, 0);
  assert.equal(spawnSync('codex', ['plugin', 'add', 'megalens@megalens', '--json'], { env: cliEnv }).status, 0);

  const res = await queryCodexAppServer({
    env: cliEnv,
    cwd: customerRepo,
    requests: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1.0' }, capabilities: { experimentalApi: true } } },
      { jsonrpc: '2.0', id: 2, method: 'plugin/read', params: { marketplacePath: mpPath, pluginName: 'megalens' } },
      { jsonrpc: '2.0', id: 3, method: 'skills/list', params: { cwds: [customerRepo] } },
    ],
  });
  const plug = res.get(2)?.result?.plugin;
  assert.deepEqual(plug?.mcpServers, ['megalens'], 'native plugin must expose megalens MCP server');
  assert.equal(plug?.summary?.interface?.displayName, 'MegaLens');
  const discoveredSkills = (res.get(3)?.result?.data?.[0]?.skills ?? []).filter((s) => s.name.startsWith('megalens:'));
  assert.deepEqual(
    discoveredSkills.map((s) => s.name).sort(),
    ['megalens:megalens-result', 'megalens:megalens-review', 'megalens:megalens-status'],
  );
  // Execute the runner resolved from the ACTUAL cached skill path discovered by Codex app-server
  const cachedReviewSkill = discoveredSkills.find((s) => s.name === 'megalens:megalens-review');
  const cachedRunner = path.resolve(path.dirname(cachedReviewSkill.path), '..', '..', 'scripts', 'codex-review.mjs');
  const cachedHelp = spawnSync(process.execPath, [cachedRunner, '--help'], {
    cwd: customerRepo,
    env: { PATH: process.env.PATH, HOME: home, MEGALENS_CODEX_PLUGIN: '1' },
    encoding: 'utf8',
  });
  assert.equal(cachedHelp.status, 0, cachedHelp.stderr);
  assert.equal(existsSync(pwnedFile), false);
});

// ---- 4. FIX 3 + Installer safety + FIX 7 TOML-aware MCP merge ----

test('FIX 3: install-codex copies self-contained runtime and persists preview opt-in across fresh CLI/desktop restarts', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-home-'));
  const codexHome = path.join(home, '.codex');
  const unrelatedRepo = mkdtempSync(path.join(tmpdir(), 'mlcodex-unrelated-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(unrelatedRepo, { recursive: true, force: true });
  });

  const r1 = installCodex({ scope: 'global', home, codexHome }, { env: { MEGALENS_CODEX_PLUGIN: '1' } });
  assert.equal(r1.code, 0);

  const installedPluginDir = path.join(home, '.codex', 'plugins', 'megalens');
  const installedRunner = path.join(installedPluginDir, 'scripts', 'codex-review.mjs');
  const optInFile = path.join(installedPluginDir, PREVIEW_OPT_IN_FILENAME);

  assert.ok(existsSync(installedRunner));
  assert.ok(existsSync(optInFile));
  assert.ok(existsSync(path.join(installedPluginDir, '.codex-plugin', 'plugin.json')));
  assert.ok(existsSync(path.join(installedPluginDir, 'mcp.json')));
  assert.ok(existsSync(path.join(installedPluginDir, 'runtime', 'scripts', 'engine.mjs')));

  // Installed skills & prompts point directly to the installed self-contained runner (never source checkout or repo-relative)
  for (const s of ['megalens-review', 'megalens-status', 'megalens-result']) {
    const md = readFileSync(path.join(home, '.agents', 'skills', s, 'SKILL.md'), 'utf8');
    const yaml = readFileSync(path.join(home, '.agents', 'skills', s, 'agents', 'openai.yaml'), 'utf8');
    assert.ok(md.includes(installedRunner), `skill ${s} must point to installed runner`);
    assert.equal(md.includes('<SKILL_DIR>'), false);
    assert.equal(md.includes('"codex/scripts/codex-review.mjs"'), false);
    assert.match(yaml, /allow_implicit_invocation: false/);
  }
  for (const p of ['megalens-review.md', 'megalens-status.md', 'megalens-result.md']) {
    const md = readFileSync(path.join(codexHome, 'prompts', p), 'utf8');
    assert.match(md, /^---\ndescription:/);
    assert.match(md, /\$ARGUMENTS/);
    assert.ok(md.includes(installedRunner), `prompt ${p} must point to installed runner`);
    assert.equal(md.includes('<SKILL_DIR>'), false);
  }

  // Simulate a fresh Codex CLI or Codex desktop app session (NO MEGALENS_CODEX_PLUGIN in env!) from an unrelated repo
  const freshRun = spawnSync(process.execPath, [installedRunner, '--help'], {
    cwd: unrelatedRepo,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
    encoding: 'utf8',
  });
  assert.equal(freshRun.status, 0, `installed runner must stay enabled after restart: ${freshRun.stdout} ${freshRun.stderr}`);
  assert.match(freshRun.stdout, /npx megalens-mcp setup\b/);

  // Explicit MEGALENS_CODEX_PLUGIN=0 still disables it immediately even with opt-in marker present
  const disabledRun = spawnSync(process.execPath, [installedRunner, '--help'], {
    cwd: unrelatedRepo,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, MEGALENS_CODEX_PLUGIN: '0' },
    encoding: 'utf8',
  });
  assert.equal(disabledRun.status, 4);
  assert.match(disabledRun.stdout, /CODEX_PLUGIN_ENABLED=false/);

  // No secret/token literal anywhere
  for (const f of walk(home)) {
    const txt = readFileSync(f, 'utf8');
    assert.ok(!/(?:mlk_|ml_tok_|sk-)[A-Za-z0-9]{10}/.test(txt), `unexpected token literal in ${f}`);
  }

  // Idempotent second run: zero updates, zero backups
  const r2 = installCodex({ scope: 'global', home, codexHome }, { env: { MEGALENS_CODEX_PLUGIN: '1' } });
  assert.equal(r2.code, 0);
  assert.ok(r2.report.every((l) => !/^(created|updated)/.test(l)), r2.report.join('\n'));
  assert.equal(existsSync(path.join(home, '.megalens', 'backups')), false);

  // Symlink opt-in marker is refused
  const symDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-optin-sym-'));
  t.after(() => rmSync(symDir, { recursive: true, force: true }));
  const target = path.join(symDir, 'real.json');
  writeFileSync(target, '{"enabled":true}\n');
  const link = path.join(symDir, PREVIEW_OPT_IN_FILENAME);
  symlinkSync(target, link);
  assert.equal(hasPersistedPreviewOptIn(link), false, 'symlink opt-in marker must be ignored');
});

test('FIX 7: --with-oauth-mcp uses TOML-aware lookup to skip inline and quoted existing mcp_servers.megalens definitions', (t) => {
  // Unit checks for TOML-aware lookup
  const existingCases = [
    '[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\n',
    '["mcp_servers".megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\n',
    "['mcp_servers'.\"megalens\"]\nurl = \"https://megalens.ai/api/mcp?ide=codex\"\n",
    '[ "mcp_servers" . \'megalens\' . http_headers ]\nAuthorization = "Bearer tok"\n',
    '[mcp_servers]\nmegalens = { url = "https://megalens.ai/api/mcp?ide=codex" }\n',
    '["mcp_servers"]\n"megalens" = { url = "https://megalens.ai/api/mcp?ide=codex" }\n',
    'mcp_servers = { megalens = { url = "https://megalens.ai/api/mcp?ide=codex" } }\n',
    '"mcp_servers"."megalens".url = "https://megalens.ai/api/mcp?ide=codex"\n',
    '[mcp_servers]\nother = { note = "[not_a_header]" }\nmegalens = { url = "https://megalens.ai/api/mcp?ide=codex" }\n',
  ];
  for (const cfg of existingCases) {
    assert.equal(hasTomlPath(cfg, ['mcp_servers', 'megalens']), true, `should detect existing megalens in:\n${cfg}`);
    assert.equal(hasExistingMegalensMcp(cfg), true, `hasExistingMegalensMcp failed for:\n${cfg}`);
  }

  // Negative cases: comments, strings, or unrelated servers must NOT falsely skip
  const nonExistingCases = [
    '# [mcp_servers.megalens]\nmodel = "gpt-6.2-sol"\n',
    'note = "[mcp_servers.megalens]"\n[mcp_servers.other]\ncommand = "other"\n',
    '[mcp_servers]\nother = { url = "https://example.com" }\n',
  ];
  for (const cfg of nonExistingCases) {
    assert.equal(hasExistingMegalensMcp(cfg), false, `false positive on:\n${cfg}`);
  }

  // End-to-end installer tests for quoted table + inline entry under [mcp_servers] + top-level inline table
  for (const cfg of existingCases) {
    const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-toml-skip-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const codexHome = path.join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, 'config.toml');
    writeFileSync(cfgPath, cfg, { mode: 0o600 });

    const r = installCodex({ scope: 'global', home, codexHome, withOauthMcp: true }, { flags: { codexPlugin: true } });
    assert.equal(r.code, 0, `installer must succeed and skip existing config:\n${cfg}`);
    assert.equal(readFileSync(cfgPath, 'utf8'), cfg, 'existing config.toml must remain untouched');
    assert.ok(r.report.some((l) => /skipped.*already defines mcp_servers\.megalens/.test(l)));
    assert.ok(existsSync(path.join(home, '.agents', 'skills', 'megalens-review', 'SKILL.md')));
  }

  // Case without existing megalens: appends managed block, preserves CRLF, writes 0600 backup
  const homeAdd = mkdtempSync(path.join(tmpdir(), 'mlcodex-mcp-add-'));
  t.after(() => rmSync(homeAdd, { recursive: true, force: true }));
  const codexHomeAdd = path.join(homeAdd, '.codex');
  mkdirSync(codexHomeAdd, { recursive: true });
  const cfgAddPath = path.join(codexHomeAdd, 'config.toml');
  const orig = '# [mcp_servers.megalens] commented out\r\nmodel = "gpt-6.2-sol"\r\n\r\n[mcp_servers.other]\r\ncommand = "other"\r\n';
  writeFileSync(cfgAddPath, orig);
  const rAdd = installCodex({ scope: 'global', home: homeAdd, codexHome: codexHomeAdd, withOauthMcp: true }, { flags: { codexPlugin: true } });
  assert.equal(rAdd.code, 0);
  const updated = readFileSync(cfgAddPath, 'utf8');
  assert.ok(updated.startsWith('# [mcp_servers.megalens] commented out\r\n'));
  assert.match(updated, /\[mcp_servers\.megalens\]/);
  assert.match(updated, /https:\/\/megalens\.ai\/api\/mcp\?ide=codex/);
  assert.ok(checkToml(updated));
  assert.ok(!/(^|[^\r])\n/.test(updated), 'keeps CRLF line endings');
  const baks = walk(path.join(homeAdd, '.megalens', 'backups'));
  assert.equal(baks.length, 1);
  assert.equal(statSync(baks[0]).mode & 0o777, 0o600);
  assert.equal(readFileSync(baks[0], 'utf8'), orig);
});

test('install-codex: merges marketplace without clobbering other plugins; project scope isolates repo; dry-run & symlinks safe', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-proj-home-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'mlcodex-proj-repo-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // Existing marketplace with another plugin
  mkdirSync(path.join(repo, '.agents', 'plugins'), { recursive: true });
  const origMp = JSON.stringify({
    name: 'team-tools',
    interface: { displayName: 'Team Tools' },
    plugins: [{ name: 'other-plugin', source: { source: 'local', path: './plugins/other' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }],
  }, null, 2);
  writeFileSync(path.join(repo, '.agents', 'plugins', 'marketplace.json'), origMp);

  // Dry-run touches nothing
  const dry = installCodex({ scope: 'project', dir: repo, home, dryRun: true }, { flags: { codexPlugin: true } });
  assert.equal(dry.code, 0);
  assert.equal(readFileSync(path.join(repo, '.agents', 'plugins', 'marketplace.json'), 'utf8'), origMp);
  assert.equal(existsSync(path.join(repo, '.agents', 'skills')), false);

  // Real project install keeps other-plugin and stores backup outside repo (in home)
  const r = installCodex({ scope: 'project', dir: repo, home }, { flags: { codexPlugin: true } });
  assert.equal(r.code, 0);
  const mp = JSON.parse(readFileSync(path.join(repo, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(mp.name, 'team-tools');
  assert.deepEqual(mp.plugins.map((p) => p.name), ['other-plugin', 'megalens']);
  assert.equal(existsSync(path.join(home, '.codex', 'prompts')), false, 'project install never writes global prompts');
  assert.equal(walk(path.join(home, '.megalens', 'backups')).length, 1);
  assert.ok(walk(repo).every((f) => !f.includes('backups')));

  // Symlink refusal: nothing written
  const symHome = mkdtempSync(path.join(tmpdir(), 'mlcodex-sym-'));
  t.after(() => rmSync(symHome, { recursive: true, force: true }));
  const victim = path.join(symHome, 'victim');
  writeFileSync(victim, 'keep');
  mkdirSync(path.join(symHome, '.agents', 'plugins'), { recursive: true });
  symlinkSync(victim, path.join(symHome, '.agents', 'plugins', 'marketplace.json'));
  assert.throws(
    () => installCodex({ scope: 'global', home: symHome, codexHome: path.join(symHome, '.codex') }, { flags: { codexPlugin: true } }),
    /symbolic link/,
  );
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.equal(existsSync(path.join(symHome, '.codex', 'prompts')), false, 'all-or-nothing: nothing written on failure');

  // Invalid args rejected
  assert.throws(() => parseInstallArgs(['--bogus']));
  assert.throws(() => parseInstallArgs(['--dir']));
});

// ---- 5. Static validation of codex/ manifests, skills, prompts, README, package.json bin ----

test('codex/ manifests, config example, skills, prompts, README and package.json follow Codex specs and fix-round invariants', () => {
  const pkgJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkgJson.bin['megalens-codex-install'], 'codex/scripts/install-codex.mjs');

  const plugin = JSON.parse(readFileSync(path.join(CODEX_DIR, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'megalens');
  assert.equal(plugin.skills, './skills/');
  assert.equal(plugin.mcpServers, './mcp.json');
  assert.equal(plugin.interface.displayName, 'MegaLens');
  assert.equal(plugin.interface.privacyPolicyURL, 'https://megalens.ai/privacy');
  assert.equal(existsSync(path.join(CODEX_DIR, 'plugin.json')), false, 'use .codex-plugin/plugin.json so codex-cli loads mcpServers');

  const mcp = JSON.parse(readFileSync(path.join(CODEX_DIR, 'mcp.json'), 'utf8'));
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.equal(mcp.mcpServers.megalens.type, 'streamable-http');
  assert.equal(mcp.mcpServers.megalens.url, 'https://megalens.ai/api/mcp?ide=codex');
  assert.equal(mcp.mcpServers.megalens.extensions['com.openai'].auth.type, 'oauth');

  const mp = JSON.parse(readFileSync(path.join(CODEX_DIR, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(mp.name, 'megalens');
  assert.equal(mp.plugins[0].name, 'megalens');
  assert.equal(mp.plugins[0].source.source, 'local');
  assert.ok(mp.plugins[0].source.path.startsWith('./'));
  assert.equal(mp.plugins[0].policy.installation, 'NOT_AVAILABLE');

  const exampleToml = readFileSync(path.join(CODEX_DIR, 'config.desktop.example.toml'), 'utf8');
  assert.ok(checkToml(exampleToml));
  assert.match(exampleToml, /\[mcp_servers\.megalens\]/);
  assert.match(exampleToml, /npx megalens-mcp setup\b/);
  assert.equal(exampleToml.includes('setup codex'), false);
  assert.ok(!/ml_tok_|mlk_|sk-/.test(exampleToml));

  for (const s of ['megalens-review', 'megalens-status', 'megalens-result']) {
    const skillMd = readFileSync(path.join(CODEX_DIR, 'skills', s, 'SKILL.md'), 'utf8');
    const yaml = readFileSync(path.join(CODEX_DIR, 'skills', s, 'agents', 'openai.yaml'), 'utf8');
    assert.match(skillMd, new RegExp(`^---\\nname: ${s}\\ndescription:`));
    assert.ok(skillMd.includes('<SKILL_DIR>/../../scripts/codex-review.mjs'));
    assert.equal(skillMd.includes('"codex/scripts/codex-review.mjs"'), false);
    assert.equal(skillMd.includes('setup codex'), false);
    assert.match(yaml, /allow_implicit_invocation: false/);
  }

  const reviewPrompt = readFileSync(path.join(CODEX_DIR, 'prompts', 'megalens-review.md'), 'utf8');
  assert.match(reviewPrompt, /argument-hint: \[deep\]/);
  assert.match(reviewPrompt, /\$ARGUMENTS/);
  assert.match(reviewPrompt, /\$\$megalens-result/);
  assert.match(reviewPrompt, /never start a second review command/i);
  assert.match(reviewPrompt, /Never push on your own/);
  assert.ok(reviewPrompt.includes('<SKILL_DIR>/../../scripts/codex-review.mjs'));
  assert.equal(reviewPrompt.includes('"codex/scripts/codex-review.mjs"'), false);
  assert.equal(reviewPrompt.includes('setup codex'), false);

  const readme = readFileSync(path.join(CODEX_DIR, 'README.md'), 'utf8');
  assert.match(readme, /npx megalens-mcp setup\b/);
  assert.match(readme, /megalens-codex-install/);
  assert.match(readme, /APP_PATH_ENABLED = false/);
  assert.match(readme, /CODEX_PLUGIN_ENABLED = false/);
  assert.match(readme, /NOT_AVAILABLE/);
  assert.match(readme, /\$megalens:megalens-review/);
  assert.match(readme, /gh secret set MEGALENS_TOKEN/);
  assert.match(readme, /Zero-copy GitHub first-run status:\*\* Blocked/i);
});
