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
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APP_PATH_ENABLED,
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
import { findTomlInlineTable, hasTomlPath, insertIntoTomlInlineTable, validateToml } from '../codex/scripts/toml-inspect.mjs';
import { realExec } from '../codex/runtime/scripts/lib/gh-runner.mjs';
import { main as claudeMain } from '../scripts/engine.mjs';
import { CHECK_NAME } from '../scripts/lib/gh-runner.mjs';
import { checkToml } from '../scripts/hosts/toml-check.mjs';

const releasePins = JSON.parse(readFileSync(new URL('../release/pins.json', import.meta.url), 'utf8'));
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
  assert.equal(sc.calls.filter(({ args }) => args[0] === 'run' && args[1] === 'download').length, 1);
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
  assert.equal(r.text, `GitHub Actions workflow setup required (https://megalens.ai/app/start).\n${CODEX_WORKFLOW_SETUP_NOTE}\n`);
  assert.equal(r.text.includes('Install the MegaLens GitHub App'), false, 'must not instruct user to install disabled App');
  assert.match(r.text, /APP_PATH_ENABLED=false/);
  assert.match(r.text, /gh auth login/);
  assert.match(r.text, /\.github\/workflows\/megalens-dispatch\.yml/);
  assert.match(r.text, /--runner github/);
  assert.match(r.text, /gh secret set MEGALENS_TOKEN/);
  assert.match(r.text, /npx megalens-review init/);
  const explicit = await runCodex(['review', '--runner', 'github'], { exec: sc.exec, stateDir });
  assert.equal(explicit.code, 4);
  assert.match(explicit.text, /not on your default branch/);
  assert.match(explicit.text, /workflow_dispatch:/);
  assert.match(explicit.text, /secrets\.MEGALENS_TOKEN/);
  assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow'), false);
});

test('first GitHub review reports missing gh login, then blocks a missing Actions credential without dispatching', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-first-github-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const setup = makeScenario({ workflowPresent: true });
  const login = await runCodex(['review'], {
    stateDir,
    exec: (cmd, args, opts) => cmd === 'gh' && args[0] === 'auth' ? bad() : setup.exec(cmd, args, opts),
  });
  assert.equal(login.code, 4);
  assert.match(login.text, /^GitHub CLI .* is not logged in\./);

  const missingSecret = (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return ok(JSON.stringify({ nameWithOwner: 'acme/codex-app', defaultBranchRef: { name: 'main' }, isInOrganization: false }));
    }
    if (cmd === 'gh' && args[0] === 'secret') return ok('[]');
    if (cmd === 'gh' && args.some((arg) => arg.endsWith('/organization-secrets'))) return bad('HTTP 404');
    return setup.exec(cmd, args, opts);
  };
  for (const args of [['review'], ['review', '--runner', 'github']]) {
    const blocked = await runCodex(args, { stateDir, exec: missingSecret });
    assert.equal(blocked.code, 4);
    assert.match(blocked.text, /repository secret MEGALENS_TOKEN is missing/);
    assert.match(blocked.text, /npx megalens-review init/);
    assert.match(blocked.text, /codex mcp login megalens/);
    assert.match(blocked.text, /private terminal prompt/);
  }
  assert.equal(setup.calls.some(({ args }) => args[0] === 'workflow'), false);
});

test('findings can be retrieved from the same run after primary artifact upload fails', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-upload-recovery-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const scenario = makeScenario({ workflowPresent: true });
  const downloads = [];
  const exec = (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'run' && args[1] === 'download') {
      const artifact = args[args.indexOf('-n') + 1];
      downloads.push([args[2], artifact]);
      if (artifact === 'megalens-findings') return bad('no valid artifacts found to download');
    }
    return scenario.exec(cmd, args, opts);
  };
  const review = await runCodex(['review'], { exec, stateDir });
  assert.equal(review.code, 0, review.text);
  assert.match(review.text, /Off-by-one tax discount/);
  assert.deepEqual(downloads, [['8001', 'megalens-findings'], ['8001', 'megalens-findings-retry']]);
  assert.equal(scenario.calls.filter(({ args }) => args[0] === 'workflow').length, 1);
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
  assert.match(rRes.text, /avoid starting a new review/i);
  assert.match(rRes.text, /https:\/\/github\.com\/acme\/codex-app\/actions\/runs\/8001/);
  assert.equal(missingArtifact.calls.filter(({ args }) => args[0] === 'run' && args[1] === 'download').length, 2);
  assert.equal(missingArtifact.calls.some(({ args }) => args[0] === 'workflow'), false);

  // Codex bundled workflow template includes transient upload retry while keeping pinned action SHAs
  const codexWf = readFileSync(path.join(CODEX_DIR, 'runtime', 'templates', 'megalens-dispatch.yml'), 'utf8');
  assert.match(codexWf, /id:\s*upload-findings/);
  assert.match(codexWf, /continue-on-error:\s*true/);
  assert.match(codexWf, /steps\.upload-findings\.outcome == 'failure'/);
  assert.match(codexWf, /id: retry-findings[\s\S]*name: megalens-findings-retry/);
  assert.doesNotMatch(codexWf, /overwrite:\s*true/);
  assert.match(codexWf, /name: \$\{\{ needs\.review\.outputs\.artifact_name \}\}/);
  assert.ok(codexWf.includes(`megalens/review-action@${releasePins.actions.MEGALENS.sha}`));
  assert.ok(codexWf.includes(`actions/upload-artifact@${releasePins.actions.UPLOAD.sha}`));
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

test('FIX 2 + output adaptation: uses native `codex mcp login megalens` OAuth (not `setup codex`), preserves findings, scrubs secrets', async (t) => {
  const findingLine = '- **P1** `docs/help.md:4`: Example says `/megalens:review` instead of `$megalens-review`';
  assert.equal(adaptCodexOutput(findingLine), findingLine);
  assert.equal(
    adaptCodexOutput('Still running. Run /megalens:result to see it.'),
    'Still running. Run $megalens-result to see it.',
  );
  const adaptedAuth = adaptCodexOutput('Set MEGALENS_TOKEN and restart Claude Code. Without a repo or without the engine installed, /megalens:megalens-review still works with a token.');
  assert.match(adaptedAuth, /restart Codex.*codex mcp login megalens`/);
  assert.equal(adaptedAuth.includes('setup codex'), false);

  // Fresh Codex profile WITH another editor (~/.claude.json) already present and NO ~/.codex/config.toml:
  // --with-oauth-mcp writes [mcp_servers.megalens] cleanly so `codex mcp login megalens` works with zero token paste.
  const freshHome = mkdtempSync(path.join(tmpdir(), 'mlcodex-fresh-oauth-'));
  t.after(() => rmSync(freshHome, { recursive: true, force: true }));
  writeFileSync(path.join(freshHome, '.claude.json'), '{}\n');
  const freshCodexHome = path.join(freshHome, '.codex');
  const inst = installCodex(
    { scope: 'global', home: freshHome, codexHome: freshCodexHome, withOauthMcp: true },
    { env: { MEGALENS_CODEX_PLUGIN: '1', HOME: freshHome, CODEX_HOME: freshCodexHome } },
  );
  assert.equal(inst.code, 0, inst.report.join('\n'));
  const freshCfg = readFileSync(path.join(freshCodexHome, 'config.toml'), 'utf8');
  assert.ok(checkToml(freshCfg));
  assert.match(freshCfg, /\[mcp_servers\.megalens\]/);
  assert.match(freshCfg, /https:\/\/megalens\.ai\/api\/mcp\?ide=codex/);
  assert.ok(!/ml_tok_|mlk_|sk-|Bearer /i.test(freshCfg), 'no bearer token written to disk');
  if (hasCodexCli()) {
    const mcpList = spawnSync('codex', ['mcp', 'list'], {
      cwd: freshHome,
      env: { PATH: process.env.PATH, HOME: freshHome, CODEX_HOME: freshCodexHome },
      encoding: 'utf8',
    });
    assert.equal(mcpList.status, 0, mcpList.stderr);
    assert.match(mcpList.stdout, /megalens\s+https:\/\/megalens\.ai\/api\/mcp\?ide=codex\b/);
  }

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

test('codex CLI subprocess: default OFF exits 4; MEGALENS_CODEX_PLUGIN=1 --help exits 0 (including via symlink)', (t) => {
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
  assert.match(helpOut, /codex mcp login megalens\b/);
  assert.equal(helpOut.includes('setup codex'), false);
  assert.match(helpOut, /GitHub App path enabled: false/);

  // Invoking codex-review.mjs through a symlink must still execute the CLI entrypoint
  const symTmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-symcli-'));
  t.after(() => rmSync(symTmp, { recursive: true, force: true }));
  const binLink = path.join(symTmp, 'megalens-codex-review');
  symlinkSync(script, binLink);
  const symHelp = spawnSync(process.execPath, [binLink, '--help'], {
    env: { PATH: process.env.PATH, HOME: symTmp, MEGALENS_CODEX_PLUGIN: '1' },
    encoding: 'utf8',
  });
  assert.equal(symHelp.status, 0, symHelp.stderr);
  assert.match(symHelp.stdout, /Usage: codex-review\.mjs/);
});

// ---- 3. FIX 1: Bundled runtime isolation, parity, decoy attack defense, and real codex-cli plugin/read ----

test('FIX 1: Codex uses the shared workflow and bundles its own runtime without external imports', () => {
  const syncedFiles = [
    'scripts/hosts/toml-check.mjs',
    'scripts/lib/local-standard.mjs',
    'scripts/lib/safety.mjs',
    'templates/megalens-dispatch.yml',
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
  assert.match(onRun.stdout, /codex mcp login megalens\b/);
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
  assert.match(freshRun.stdout, /codex mcp login megalens\b/);

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

test('FIX 3 (round 2): symlinked npm bin (`npx --package ... megalens-codex-install`) actually runs and persists opt-in', (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-npxbin-'));
  const home = path.join(tmp, 'home');
  const codexHome = path.join(home, '.codex');
  const customerRepo = path.join(tmp, 'customer');
  const fakeBinDir = path.join(tmp, 'node_modules', '.bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(customerRepo, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // 1. Direct npm-style symlink invocation from an unrelated working directory
  const binSymlink = path.join(fakeBinDir, 'megalens-codex-install');
  symlinkSync(path.join(CODEX_DIR, 'scripts', 'install-codex.mjs'), binSymlink);
  const symRun = spawnSync(process.execPath, [binSymlink, '--with-oauth-mcp'], {
    cwd: customerRepo,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, MEGALENS_CODEX_PLUGIN: '1' },
    encoding: 'utf8',
  });
  assert.equal(symRun.status, 0, symRun.stderr);
  assert.match(symRun.stdout, /created\s+.*\.codex-plugin-preview-enabled/);
  const optInFile = path.join(home, '.codex', 'plugins', 'megalens', PREVIEW_OPT_IN_FILENAME);
  assert.ok(existsSync(optInFile), 'opt-in marker must be created when invoked via npm bin symlink');
  assert.ok(existsSync(path.join(home, '.agents', 'skills', 'megalens-review', 'SKILL.md')));
  assert.ok(existsSync(path.join(codexHome, 'config.toml')));

  // Fresh process without MEGALENS_CODEX_PLUGIN runs enabled from unrelated repo
  const installedRunner = path.join(home, '.codex', 'plugins', 'megalens', 'scripts', 'codex-review.mjs');
  const afterRestart = spawnSync(process.execPath, [installedRunner, '--help'], {
    cwd: customerRepo,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
    encoding: 'utf8',
  });
  assert.equal(afterRestart.status, 0, `${afterRestart.stdout}\n${afterRestart.stderr}`);

  // 2. Real `npm pack` + `npx --yes --package <tgz> megalens-codex-install --with-oauth-mcp` end-to-end
  const packDir = path.join(tmp, 'pack');
  const npxHome = path.join(tmp, 'npx-home');
  const npxCodexHome = path.join(npxHome, '.codex');
  const npmCache = path.join(tmp, 'npm-cache');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(npxHome, { recursive: true });
  const packRes = spawnSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packDir], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: npxHome, npm_config_cache: npmCache },
    encoding: 'utf8',
  });
  assert.equal(packRes.status, 0, packRes.stderr);
  const tgzName = packRes.stdout.trim().split('\n').pop();
  const tgzPath = path.join(packDir, tgzName);
  const npxRes = spawnSync(
    'npx',
    ['--yes', '--package', tgzPath, 'megalens-codex-install', '--with-oauth-mcp'],
    {
      cwd: customerRepo,
      env: {
        PATH: process.env.PATH,
        HOME: npxHome,
        CODEX_HOME: npxCodexHome,
        npm_config_cache: npmCache,
        MEGALENS_CODEX_PLUGIN: '1',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(npxRes.status, 0, `${npxRes.stdout}\n${npxRes.stderr}`);
  const npxMarker = path.join(npxHome, '.codex', 'plugins', 'megalens', PREVIEW_OPT_IN_FILENAME);
  assert.ok(existsSync(npxMarker), 'opt-in marker must exist after real `npx --package <tgz> megalens-codex-install`');
  assert.ok(existsSync(path.join(npxCodexHome, 'config.toml')));

  // Delete tarball and npm cache completely; installed runner still works in a fresh session without MEGALENS_CODEX_PLUGIN
  rmSync(packDir, { recursive: true, force: true });
  rmSync(npmCache, { recursive: true, force: true });
  const npxRunner = path.join(npxHome, '.codex', 'plugins', 'megalens', 'scripts', 'codex-review.mjs');
  const postNpx = spawnSync(process.execPath, [npxRunner, '--help'], {
    cwd: customerRepo,
    env: { PATH: process.env.PATH, HOME: npxHome, CODEX_HOME: npxCodexHome },
    encoding: 'utf8',
  });
  assert.equal(postNpx.status, 0, `${postNpx.stdout}\n${postNpx.stderr}`);
});

test('FIX 7: --with-oauth-mcp handles inline-table mcp_servers and skips existing inline/quoted megalens definitions', (t) => {
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
    'mcp_servers = { other = { command = "true" } }\n',
  ];
  for (const cfg of nonExistingCases) {
    assert.equal(hasExistingMegalensMcp(cfg), false, `false positive on:\n${cfg}`);
  }

  // Inline-table merge cases (e.g. `mcp_servers = { other = { command = "true" } }` — valid in Codex CLI)
  const inlineMergeCases = [
    'mcp_servers = { other = { command = "true" } }\n',
    'mcp_servers = {}\n',
    '"mcp_servers" = { other = { command = "true" } }\n',
    'model = "gpt-6.2-sol"\nmcp_servers = { other = { command = "true" } } # user comment\n',
    'mcp_servers.other = { command = "true" }\n',
  ];
  for (const cfg of inlineMergeCases) {
    const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-toml-inline-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const codexHome = path.join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, 'config.toml');
    writeFileSync(cfgPath, cfg, { mode: 0o600 });

    const r = installCodex({ scope: 'global', home, codexHome, withOauthMcp: true }, { flags: { codexPlugin: true } });
    assert.equal(r.code, 0, `installer must not abort on valid config:\n${cfg}`);
    const merged = readFileSync(cfgPath, 'utf8');
    assert.ok(checkToml(merged), `merged TOML must be valid:\n${merged}`);
    assert.equal(hasTomlPath(merged, ['mcp_servers', 'megalens']), true, `megalens must be added:\n${merged}`);
    if (cfg.includes('other')) {
      assert.equal(hasTomlPath(merged, ['mcp_servers', 'other']), true, `other server must be preserved:\n${merged}`);
    }
    assert.ok(existsSync(path.join(home, '.agents', 'skills', 'megalens-review', 'SKILL.md')));

    // Idempotent second run keeps merged config untouched (skipped for inline-table merge, unchanged for managed block)
    const r2 = installCodex({ scope: 'global', home, codexHome, withOauthMcp: true }, { flags: { codexPlugin: true } });
    assert.equal(r2.code, 0);
    assert.equal(readFileSync(cfgPath, 'utf8'), merged);
    assert.ok(
      r2.report.some((l) => /(?:skipped.*already defines mcp_servers\.megalens|unchanged\s+.*config\.toml)/.test(l)),
      r2.report.join('\n'),
    );

    // Verify real `codex mcp list` accepts the merged config and lists megalens (and other when present)
    if (hasCodexCli()) {
      const mcpList = spawnSync('codex', ['mcp', 'list'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
        encoding: 'utf8',
      });
      assert.equal(mcpList.status, 0, `codex mcp list rejected merged TOML:\n${merged}\n${mcpList.stderr}`);
      assert.match(mcpList.stdout, /\bmegalens\b/);
      if (cfg.includes('other')) assert.match(mcpList.stdout, /\bother\b/);
    }
  }

  // Unit check for findTomlInlineTable + insertIntoTomlInlineTable
  const span = findTomlInlineTable('mcp_servers = { a = { command = "true" } }\n', ['mcp_servers']);
  assert.ok(span);
  assert.equal(span.hasEntries, true);
  assert.ok(checkToml(insertIntoTomlInlineTable('mcp_servers = { a = { command = "true" } }\n', span, 'b', '{ url = "https://example.com" }')));

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

  // Long bare key (>256 chars) in valid Codex config.toml + TOML 1.1 multiline inline table (round 3 FIX 7)
  const longEnvName = `MEGALENS_TEST_${'A'.repeat(260)}`;
  const longAndV11Cases = [
    `mcp_servers = { other = { command = "true", env = { ${longEnvName} = "sample" } } }\n`,
    `mcp_servers = {\n  other = { command = "true", env = { ${longEnvName} = "sample" } }, # comment\n}\n`,
    `mcp_servers = {\n  # empty for now\n}\n`,
    `[profiles.dev]\n${longEnvName} = "ok"\n\n[mcp_servers.other]\ncommand = "true"\n`,
  ];
  for (const cfg of longAndV11Cases) {
    const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-toml-long-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const codexHome = path.join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, 'config.toml');
    writeFileSync(cfgPath, cfg, { mode: 0o600 });

    const r = installCodex({ scope: 'global', home, codexHome, withOauthMcp: true }, { flags: { codexPlugin: true } });
    assert.equal(r.code, 0, `installer must handle long keys & TOML 1.1 inline tables:\n${cfg}`);
    const merged = readFileSync(cfgPath, 'utf8');
    assert.ok(validateToml(merged), `merged TOML must validate:\n${merged}`);
    assert.equal(hasTomlPath(merged, ['mcp_servers', 'megalens']), true, `megalens must be added:\n${merged}`);
    assert.ok(existsSync(path.join(home, '.agents', 'skills', 'megalens-review', 'SKILL.md')));

    if (hasCodexCli()) {
      const mcpList = spawnSync('codex', ['mcp', 'list'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
        encoding: 'utf8',
      });
      assert.equal(mcpList.status, 0, `codex mcp list rejected merged TOML:\n${merged}\n${mcpList.stderr}`);
      assert.match(mcpList.stdout, /\bmegalens\b/);
    }
  }

  // Existing megalens alongside a >256-char key must still be detected and skipped cleanly
  const longExisting = `mcp_servers = { other = { command = "true", env = { ${longEnvName} = "sample" } }, megalens = { url = "https://megalens.ai/api/mcp?ide=codex" } }\n`;
  assert.equal(hasExistingMegalensMcp(longExisting), true);

  // Corrupt TOML is still rejected with zero writes (all-or-nothing)
  const badHome = mkdtempSync(path.join(tmpdir(), 'mlcodex-toml-bad-'));
  t.after(() => rmSync(badHome, { recursive: true, force: true }));
  const badCodexHome = path.join(badHome, '.codex');
  mkdirSync(badCodexHome, { recursive: true });
  writeFileSync(path.join(badCodexHome, 'config.toml'), 'mcp_servers = { broken\n');
  assert.throws(
    () => installCodex({ scope: 'global', home: badHome, codexHome: badCodexHome, withOauthMcp: true }, { flags: { codexPlugin: true } }),
    /cannot take the MegaLens MCP block/,
  );
  assert.equal(existsSync(path.join(badHome, '.agents', 'skills')), false);

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

test('OAuth installation preserves marker text in a valid multiline TOML string', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-oauth-marker-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  mkdirSync(codexHome);
  const cfg = path.join(codexHome, 'config.toml');
  const original = "developer_instructions = '''\n"
    + '# >>> megalens-codex-plugin (managed block, safe to delete) >>>\n'
    + 'Example managed block\n'
    + '# <<< megalens-codex-plugin <<<\n'
    + "'''\n";
  writeFileSync(cfg, original);
  const opts = { home, codexHome, withOauthMcp: true };
  const context = { flags: { codexPlugin: true } };
  assert.equal(installCodex(opts, context).code, 0);
  const merged = readFileSync(cfg, 'utf8');
  assert.ok(merged.startsWith(original));
  assert.ok(hasTomlPath(merged, ['mcp_servers', 'megalens']));
  assert.equal(installCodex(opts, context).code, 0);
  assert.equal(readFileSync(cfg, 'utf8'), merged);
});

test('subdirectory installs keep the runner out of the whole checkout and preserve other installed scopes', (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-nested-project-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'profile');
  const codexHome = path.join(repo, '.codex');
  const project = path.join(repo, 'packages', 'service');
  const second = path.join(repo, 'packages', '[other]');
  const linkedCodexHome = path.join(tmp, 'profile-link');
  mkdirSync(project, { recursive: true });
  mkdirSync(second, { recursive: true });
  mkdirSync(codexHome);
  symlinkSync(codexHome, linkedCodexHome, 'dir');
  execFileSync('git', ['init', '-q', repo]);
  const context = { flags: { codexPlugin: true } };
  assert.equal(installCodex({ scope: 'project', dir: project, home, codexHome }, context).code, 0);
  assert.equal(installCodex({ scope: 'project', dir: second, home, codexHome: linkedCodexHome }, context).code, 0);
  assert.equal(existsSync(path.join(codexHome, 'plugins')), false);
  const runner = path.join(home, '.codex', 'plugins', 'megalens', 'scripts', 'codex-review.mjs');
  for (const dir of [project, second]) {
    const skill = readFileSync(path.join(dir, '.agents', 'skills', 'megalens-review', 'SKILL.md'), 'utf8');
    assert.ok(skill.includes(runner));
  }
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('project OAuth install keeps a tracked config unchanged and adds OAuth to the user profile', (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-tracked-config-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'profile');
  const codexHome = path.join(home, '.codex');
  const cfg = path.join(repo, '.codex', 'config.toml');
  const original = 'approval_policy = "on-request"\n';
  mkdirSync(path.dirname(cfg), { recursive: true });
  writeFileSync(cfg, original);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.codex/config.toml']);
  const status = () => execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  const before = status();
  assert.equal(installCodex({ scope: 'project', dir: repo, home, codexHome, withOauthMcp: true },
    { flags: { codexPlugin: true } }).code, 0);
  assert.equal(readFileSync(cfg, 'utf8'), original);
  assert.equal(status(), before);
  assert.ok(hasTomlPath(readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), ['mcp_servers', 'megalens']));
});

test('legacy upgrade keeps customer files in place and backs up removed plugin files byte for byte', (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-legacy-data-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'profile');
  const repo = path.join(tmp, 'repo');
  const legacy = path.join(repo, '.codex', 'plugins', 'megalens');
  const notes = path.join(legacy, 'local-review-notes.md');
  const runner = path.join(legacy, 'scripts', 'codex-review.mjs');
  const bytes = Buffer.from([0, 255, 10, 65]);
  mkdirSync(path.dirname(runner), { recursive: true });
  writeFileSync(runner, bytes);
  writeFileSync(notes, 'customer notes\n');
  execFileSync('git', ['init', '-q', repo]);
  const context = { flags: { codexPlugin: true } };
  assert.equal(installCodex({ scope: 'project', dir: repo, home }, context).code, 0);
  assert.equal(existsSync(runner), false);
  assert.ok(existsSync(notes));
  assert.equal(readFileSync(notes, 'utf8'), 'customer notes\n');
  const backup = walk(path.join(home, '.megalens', 'backups')).find((file) => file.endsWith('codex-review.mjs'));
  assert.ok(backup);
  assert.deepEqual(readFileSync(backup), bytes);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(installCodex({ scope: 'project', dir: repo, home }, context).code, 0);
  assert.equal(readFileSync(notes, 'utf8'), 'customer notes\n');
});

test('FIX 1 + NEW HIGH: project-scoped install keeps runtime/opt-in out of repo, excludes skills in .git/info/exclude, and does not block default GitHub review', async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-proj-flow-'));
  const home = path.join(tmp, 'home');
  const codexHome = path.join(home, '.codex');
  const customer = path.join(tmp, 'customer');
  mkdirSync(home, { recursive: true });
  mkdirSync(customer, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Clean git checkout with a feature commit ahead of main
  assert.equal(spawnSync('git', ['-C', customer, 'init', '-qb', 'main']).status, 0);
  assert.equal(spawnSync('git', ['-C', customer, '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'base', '--allow-empty']).status, 0);
  assert.equal(spawnSync('git', ['-C', customer, 'checkout', '-qb', 'feature']).status, 0);
  assert.equal(spawnSync('git', ['-C', customer, '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'feature', '--allow-empty']).status, 0);

  // Dry-run touches neither repo nor .git/info/exclude nor user codexHome
  const dry = installCodex({ scope: 'project', dir: customer, home, codexHome, dryRun: true }, { env: { MEGALENS_CODEX_PLUGIN: '1', HOME: home, CODEX_HOME: codexHome } });
  assert.equal(dry.code, 0);
  assert.equal(existsSync(path.join(customer, '.agents')), false);
  assert.equal(existsSync(path.join(codexHome, 'plugins', 'megalens')), false);

  // Real project install
  const inst = installCodex({ scope: 'project', dir: customer, home, codexHome }, { env: { MEGALENS_CODEX_PLUGIN: '1', HOME: home, CODEX_HOME: codexHome } });
  assert.equal(inst.code, 0, inst.report.join('\n'));

  // 1. Runtime & preview opt-in marker live STRICTLY in user storage ($CODEX_HOME), NEVER inside the reviewed repo
  const userRunner = path.join(codexHome, 'plugins', 'megalens', 'scripts', 'codex-review.mjs');
  assert.ok(existsSync(userRunner));
  assert.ok(existsSync(path.join(codexHome, 'plugins', 'megalens', PREVIEW_OPT_IN_FILENAME)));
  assert.equal(existsSync(path.join(customer, '.codex')), false, 'must never write .codex/ runtime inside customer repo');
  assert.equal(existsSync(path.join(customer, '.agents', 'plugins')), false, 'must never write repo-local marketplace pointing into customer repo');
  for (const s of ['megalens-review', 'megalens-status', 'megalens-result']) {
    const md = readFileSync(path.join(customer, '.agents', 'skills', s, 'SKILL.md'), 'utf8');
    assert.ok(md.includes(userRunner), `project skill ${s} must point to user-owned runner outside repo`);
    assert.equal(md.includes(customer), false, `project skill ${s} must never execute code inside the reviewed repo`);
  }

  // 2. git status is completely clean because .git/info/exclude ignores only our installed skill dirs
  const gitStatus = spawnSync('git', ['-C', customer, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
  assert.equal(gitStatus.status, 0);
  assert.equal(gitStatus.stdout.trim(), '', `project install must not dirty repo: ${gitStatus.stdout}`);

  // 3. Running installed $megalens-review with simulated GitHub prerequisites does NOT reject its own files as uncommitted changes
  const headSha = spawnSync('git', ['-C', customer, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const baseSha = spawnSync('git', ['-C', customer, 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim();
  const { main: installedMain } = await import(pathToFileURL(userRunner));
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  let dispatched = false;
  let output = '';
  const code = await installedMain(['review', '--no-wait'], {
    cwd: customer,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, MEGALENS_STATE_DIR: path.join(tmp, 'state') },
    out: (line) => { output += line; },
    exec: async (cmd, args, opts) => {
      if (cmd === 'git') return realExec(cmd, args, opts);
      assert.equal(cmd, 'gh');
      if (args[0] === '--version' || args[0] === 'auth') return ok();
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'example/repo', defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'api' && args.some((a) => a.includes('/contents/'))) return ok('file');
      if (args[0] === 'api' && args.some((a) => a.includes(`/commits/${headSha}`))) return ok(`${headSha}\n`);
      if (args[0] === 'secret') return ok(JSON.stringify([{ name: 'MEGALENS_TOKEN' }]));
      if (args[0] === 'run' && args[1] === 'list') {
        if (!dispatched) return ok('[]');
        return ok(JSON.stringify([{
          databaseId: 9123,
          displayTitle: `MegaLens standard ${baseSha}..${headSha}`,
          createdAt: new Date().toISOString(),
          url: 'https://github.com/example/repo/actions/runs/9123',
        }]));
      }
      if (args[0] === 'workflow' && args[1] === 'run') {
        dispatched = true;
        return ok();
      }
      assert.fail(`Unexpected gh call: ${args.join(' ')}`);
    },
  });
  assert.equal(code, 0, `project-installed review should dispatch cleanly, got: ${output}`);
  assert.equal(dispatched, true, 'must dispatch GitHub workflow instead of failing on own install files');
  assert.doesNotMatch(output, /You have uncommitted changes/);

  // 4. Real uncommitted user file STILL triggers the dirty-worktree guard
  writeFileSync(path.join(customer, 'dirty.txt'), 'uncommitted change\n');
  let dirtyOut = '';
  const dirtyCode = await installedMain(['review', '--no-wait'], {
    cwd: customer,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, MEGALENS_STATE_DIR: path.join(tmp, 'state') },
    out: (line) => { dirtyOut += line; },
    exec: async (cmd, args, opts) => {
      if (cmd === 'git') return realExec(cmd, args, opts);
      if (args[0] === '--version' || args[0] === 'auth') return ok();
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'example/repo', defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'api' && args.some((a) => a.includes('/contents/'))) return ok('file');
      if (args[0] === 'secret') return ok(JSON.stringify([{ name: 'MEGALENS_TOKEN' }]));
      assert.fail(`Unexpected gh call on dirty worktree: ${args.join(' ')}`);
    },
  });
  assert.equal(dirtyCode, 4);
  assert.match(dirtyOut, /You have uncommitted changes/);
});

test('FIX 1 + NEW HIGH (round 3): --project --with-oauth-mcp stays clean on reinstall, cleans up legacy repo-local plugin on upgrade, and refuses codexHome inside repo', async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mlcodex-proj-r3-'));
  const home = path.join(tmp, 'home');
  const codexHome = path.join(home, '.codex');
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const initRepo = (name) => {
    const repo = path.join(tmp, name);
    mkdirSync(repo, { recursive: true });
    assert.equal(spawnSync('git', ['-C', repo, 'init', '-qb', 'main']).status, 0);
    assert.equal(spawnSync('git', ['-C', repo, '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'base', '--allow-empty']).status, 0);
    assert.equal(spawnSync('git', ['-C', repo, 'checkout', '-qb', 'feature']).status, 0);
    assert.equal(spawnSync('git', ['-C', repo, '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'feature', '--allow-empty']).status, 0);
    return repo;
  };

  // A. Reinstall with --project --with-oauth-mcp (twice, then once without --with-oauth-mcp) must keep .codex/config.toml excluded
  const reinstallRepo = initRepo('reinstall');
  const env = { MEGALENS_CODEX_PLUGIN: '1', HOME: home, CODEX_HOME: codexHome };
  const r1 = installCodex({ scope: 'project', dir: reinstallRepo, home, codexHome, withOauthMcp: true }, { env });
  assert.equal(r1.code, 0, r1.report.join('\n'));
  assert.equal(spawnSync('git', ['-C', reinstallRepo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout.trim(), '');

  const r2 = installCodex({ scope: 'project', dir: reinstallRepo, home, codexHome, withOauthMcp: true }, { env });
  assert.equal(r2.code, 0, r2.report.join('\n'));
  assert.equal(
    spawnSync('git', ['-C', reinstallRepo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout.trim(),
    '',
    'reinstall must keep .codex/config.toml excluded so repo stays clean',
  );
  assert.equal(spawnSync('git', ['-C', reinstallRepo, 'check-ignore', '-q', '.codex/config.toml']).status, 0);
  assert.ok(r2.report.every((l) => !/^(created|updated|removed)/.test(l)), `reinstall should be idempotent:\n${r2.report.join('\n')}`);

  const r3 = installCodex({ scope: 'project', dir: reinstallRepo, home, codexHome, withOauthMcp: false }, { env });
  assert.equal(r3.code, 0, r3.report.join('\n'));
  assert.equal(
    spawnSync('git', ['-C', reinstallRepo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout.trim(),
    '',
    'subsequent --project without --with-oauth-mcp must not un-ignore previously created .codex/config.toml',
  );

  // B. Upgrade from round-1 repo-local layout (.codex/plugins/megalens/ + .agents/plugins/marketplace.json + managed .codex/config.toml)
  const upgradeRepo = initRepo('upgrade');
  mkdirSync(path.join(upgradeRepo, '.codex', 'plugins', 'megalens', '.codex-plugin'), { recursive: true });
  mkdirSync(path.join(upgradeRepo, '.codex', 'plugins', 'megalens', 'scripts'), { recursive: true });
  mkdirSync(path.join(upgradeRepo, '.codex', 'plugins', 'megalens', 'skills', 'megalens-review'), { recursive: true });
  mkdirSync(path.join(upgradeRepo, '.agents', 'plugins'), { recursive: true });
  writeFileSync(path.join(upgradeRepo, '.codex', 'plugins', 'megalens', '.codex-plugin', 'plugin.json'), '{"name":"megalens"}\n');
  writeFileSync(path.join(upgradeRepo, '.codex', 'plugins', 'megalens', 'scripts', 'codex-review.mjs'), '// legacy\n');
  writeFileSync(path.join(upgradeRepo, '.codex', 'plugins', 'megalens', '.codex-plugin-preview-enabled'), '{"enabled":true}\n');
  writeFileSync(
    path.join(upgradeRepo, '.codex', 'plugins', 'megalens', 'skills', 'megalens-review', 'SKILL.md'),
    `Run \`node "${upgradeRepo}/.codex/plugins/megalens/scripts/codex-review.mjs" review\`\n`,
  );
  writeFileSync(
    path.join(upgradeRepo, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'local-repo',
      interface: { displayName: 'Local Repo Plugins' },
      plugins: [{
        name: 'megalens',
        source: { source: 'local', path: './.codex/plugins/megalens' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Developer Tools',
      }],
    }, null, 2) + '\n',
  );
  writeFileSync(
    path.join(upgradeRepo, '.codex', 'config.toml'),
    '# >>> megalens-codex-plugin (managed block, safe to delete) >>>\n'
    + '[mcp_servers.megalens]\n'
    + 'url = "https://megalens.ai/api/mcp?ide=codex"\n'
    + 'startup_timeout_sec = 20\n'
    + 'tool_timeout_sec = 1800  # reviews can take several minutes\n'
    + '# <<< megalens-codex-plugin <<<\n',
  );

  // Dry-run reports legacy cleanup without modifying disk
  const dryUp = installCodex({ scope: 'project', dir: upgradeRepo, home, codexHome, withOauthMcp: true, dryRun: true }, { env });
  assert.equal(dryUp.code, 0);
  assert.ok(dryUp.report.some((l) => /would removed/.test(l)));
  assert.ok(existsSync(path.join(upgradeRepo, '.codex', 'plugins', 'megalens')));
  assert.ok(existsSync(path.join(upgradeRepo, '.agents', 'plugins', 'marketplace.json')));

  // Real upgrade cleans stale repo-local plugin & marketplace, excludes config.toml, and leaves git status clean
  const up = installCodex({ scope: 'project', dir: upgradeRepo, home, codexHome, withOauthMcp: true }, { env });
  assert.equal(up.code, 0, up.report.join('\n'));
  assert.equal(existsSync(path.join(upgradeRepo, '.codex', 'plugins')), false, 'stale .codex/plugins/megalens must be removed');
  assert.equal(existsSync(path.join(upgradeRepo, '.agents', 'plugins', 'marketplace.json')), false, 'stale local-repo marketplace.json must be removed');
  assert.equal(
    spawnSync('git', ['-C', upgradeRepo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout.trim(),
    '',
    'upgraded repo must have completely clean git status',
  );
  if (hasCodexCli()) {
    const addMp = spawnSync('codex', ['plugin', 'marketplace', 'add', upgradeRepo], {
      cwd: upgradeRepo,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
      encoding: 'utf8',
    });
    assert.notEqual(addMp.status, 0, 'upgraded repo must not expose a stale local-repo marketplace');
  }

  // Verify default review dispatches cleanly on the upgraded repo
  const userRunner = path.join(codexHome, 'plugins', 'megalens', 'scripts', 'codex-review.mjs');
  const headSha = spawnSync('git', ['-C', upgradeRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const baseSha = spawnSync('git', ['-C', upgradeRepo, 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim();
  const { main: installedMain } = await import(pathToFileURL(userRunner));
  let dispatched = false;
  let out = '';
  const code = await installedMain(['review', '--no-wait'], {
    cwd: upgradeRepo,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, MEGALENS_STATE_DIR: path.join(tmp, 'state-up') },
    out: (s) => { out += s; },
    exec: async (cmd, args, opts) => {
      if (cmd === 'git') return realExec(cmd, args, opts);
      if (args[0] === '--version' || args[0] === 'auth') return ok();
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'example/repo', defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'api' && args.some((a) => a.includes('/contents/'))) return ok('file');
      if (args[0] === 'api' && args.some((a) => a.includes(`/commits/${headSha}`))) return ok(`${headSha}\n`);
      if (args[0] === 'secret') return ok(JSON.stringify([{ name: 'MEGALENS_TOKEN' }]));
      if (args[0] === 'run' && args[1] === 'list') {
        return ok(JSON.stringify(dispatched ? [{ databaseId: 9124, displayTitle: `MegaLens standard ${baseSha}..${headSha}`, createdAt: new Date().toISOString(), url: 'https://github.com/example/repo/actions/runs/9124' }] : []));
      }
      if (args[0] === 'workflow' && args[1] === 'run') { dispatched = true; return ok(); }
      assert.fail(`Unexpected gh call: ${args.join(' ')}`);
    },
  });
  assert.equal(code, 0, out);
  assert.equal(dispatched, true);

  // C. Upgrade preserves other plugins if .agents/plugins/marketplace.json had non-MegaLens entries
  const mixedRepo = initRepo('mixed');
  mkdirSync(path.join(mixedRepo, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    path.join(mixedRepo, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'local-repo',
      plugins: [
        { name: 'team-helper', source: { source: 'local', path: './plugins/helper' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' } },
        { name: 'megalens', source: { source: 'local', path: './.codex/plugins/megalens' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' } },
      ],
    }, null, 2) + '\n',
  );
  const upMixed = installCodex({ scope: 'project', dir: mixedRepo, home, codexHome }, { env });
  assert.equal(upMixed.code, 0);
  const remainingMp = JSON.parse(readFileSync(path.join(mixedRepo, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.deepEqual(remainingMp.plugins.map((p) => p.name), ['team-helper']);

  // D. Even if --codex-home points inside the reviewed repo, runtime falls back to user home outside the repo
  const insideRepo = initRepo('inside-codex-home');
  const insideCodexHome = path.join(insideRepo, '.codex');
  const rInside = installCodex({ scope: 'project', dir: insideRepo, home, codexHome: insideCodexHome }, { env });
  assert.equal(rInside.code, 0);
  assert.equal(existsSync(path.join(insideRepo, '.codex', 'plugins')), false, 'runtime must never land inside repo even when CODEX_HOME is inside repo');
  const insideSkill = readFileSync(path.join(insideRepo, '.agents', 'skills', 'megalens-review', 'SKILL.md'), 'utf8');
  assert.ok(insideSkill.includes(path.join(home, '.codex', 'plugins', 'megalens', 'scripts', 'codex-review.mjs')));
});

test('install-codex: merges global marketplace without clobbering other plugins; dry-run & symlinks safe', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-mp-home-'));
  const codexHome = path.join(home, '.codex');
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // Existing global marketplace with another plugin
  mkdirSync(path.join(home, '.agents', 'plugins'), { recursive: true });
  const origMp = JSON.stringify({
    name: 'team-tools',
    interface: { displayName: 'Team Tools' },
    plugins: [{ name: 'other-plugin', source: { source: 'local', path: './plugins/other' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }],
  }, null, 2);
  writeFileSync(path.join(home, '.agents', 'plugins', 'marketplace.json'), origMp);

  // Dry-run touches nothing
  const dry = installCodex({ scope: 'global', home, codexHome, dryRun: true }, { flags: { codexPlugin: true } });
  assert.equal(dry.code, 0);
  assert.equal(readFileSync(path.join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'), origMp);
  assert.equal(existsSync(path.join(home, '.agents', 'skills')), false);

  // Real global install keeps other-plugin and stores backup outside repo (in home/.megalens/backups)
  const r = installCodex({ scope: 'global', home, codexHome }, { flags: { codexPlugin: true } });
  assert.equal(r.code, 0);
  const mp = JSON.parse(readFileSync(path.join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(mp.name, 'team-tools');
  assert.deepEqual(mp.plugins.map((p) => p.name), ['other-plugin', 'megalens']);
  assert.equal(walk(path.join(home, '.megalens', 'backups')).length, 1);

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
  assert.match(exampleToml, /codex mcp login megalens\b/);
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

  const readme = readFileSync(path.join(CODEX_DIR, 'GUIDE.md'), 'utf8');
  assert.match(readme, /codex mcp login megalens\b/);
  assert.match(readme, /megalens-codex-install --with-oauth-mcp/);
  assert.match(readme, /APP_PATH_ENABLED = false/);
  assert.match(readme, /CODEX_PLUGIN_ENABLED = false/);
  assert.match(readme, /NOT_AVAILABLE/);
  assert.match(readme, /\$megalens:megalens-review/);
  assert.match(readme, /gh secret set MEGALENS_TOKEN/);
  assert.match(readme, /shared GitHub Actions setup/i);
});
