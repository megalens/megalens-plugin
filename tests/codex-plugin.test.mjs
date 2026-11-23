// Tests for the MegaLens Codex plugin (CLI + desktop app):
//   1. Feature flag default OFF (CODEX_PLUGIN_ENABLED=false; flag off = live behaviour unchanged)
//   2. One-command review logic, runner order (APP_PATH_ENABLED=false), wait loop, no-id status/result
//   3. Strict ID validation, Codex output adaptation (without mangling findings), secret scrubbing
//   4. Codex installer safety (skills, CLI prompts, marketplace, optional MCP TOML, backups, symlinks, idempotency)
//   5. Manifest, prompt, skill, and README validation
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_PLUGIN_ENABLED, CODEX_PLUGIN_OFF_MESSAGE, isCodexPluginEnabled } from '../codex/scripts/flags.mjs';
import { adaptCodexOutput, isValidCodexReviewId, main as codexMain } from '../codex/scripts/codex-review.mjs';
import { installCodex, parseArgs as parseInstallArgs } from '../codex/scripts/install-codex.mjs';
import { main as claudeMain } from '../scripts/engine.mjs';
import { APP_PATH_ENABLED, CHECK_NAME, WORKFLOW_PATH } from '../scripts/lib/gh-runner.mjs';
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
      if (!downloadDoc) return bad('no artifact');
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

// ---- 1. Feature flag default OFF ----

test('flags: CODEX_PLUGIN_ENABLED and APP_PATH_ENABLED are both OFF by default', () => {
  assert.equal(CODEX_PLUGIN_ENABLED, false);
  assert.equal(APP_PATH_ENABLED, false);
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

// ---- 2. One-command review & runner order ----

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

test('codex review: prints exact setup line when workflow is missing and never falls back to local engine', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mlcodex-nosetup-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sc = makeScenario({ workflowPresent: false });
  const r = await runCodex(['review'], {
    exec: sc.exec,
    stateDir,
    env: { MEGALENS_TOKEN: TOKEN },
  });
  assert.equal(r.code, 4);
  assert.equal(r.text, `${SETUP_LINE}\n`);
  assert.equal(sc.calls.some(({ args }) => args[0] === 'workflow'), false);
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

test('codex output adaptation: rewrites plugin UX hints without mangling findings; scrubs secrets', async (t) => {
  // Finding quoting /megalens:review inside code stays verbatim
  const findingLine = '- **P1** `docs/help.md:4`: Example says `/megalens:review` instead of `$megalens-review`';
  assert.equal(adaptCodexOutput(findingLine), findingLine);
  assert.equal(
    adaptCodexOutput('Still running. Run /megalens:result to see it.'),
    'Still running. Run $megalens-result to see it.',
  );
  assert.match(
    adaptCodexOutput('Set MEGALENS_TOKEN and restart Claude Code. Without a repo or without the engine installed, /megalens:megalens-review still works with a token.'),
    /restart Codex.*npx megalens-mcp setup codex/,
  );

  // Secret scrubbing end-to-end
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

test('codex CLI subprocess: default OFF exits 4; MEGALENS_CODEX_PLUGIN=1 --help exits 0', () => {
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
  assert.match(helpOut, /npx megalens-mcp setup codex/);
  assert.match(helpOut, /GitHub App path enabled: false/);
});

// ---- 3. Codex installer tests ----

test('install-codex global: installs skills, CLI prompts, plugin + marketplace; idempotent; writes no tokens', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-home-'));
  const codexHome = path.join(home, '.codex');
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const r1 = installCodex({ scope: 'global', home, codexHome }, { flags: { codexPlugin: true } });
  assert.equal(r1.code, 0);

  // Skills
  for (const s of ['megalens-review', 'megalens-status', 'megalens-result']) {
    const md = readFileSync(path.join(home, '.agents', 'skills', s, 'SKILL.md'), 'utf8');
    const yaml = readFileSync(path.join(home, '.agents', 'skills', s, 'agents', 'openai.yaml'), 'utf8');
    assert.match(md, /codex-review\.mjs/);
    assert.ok(!md.includes('"codex/scripts/codex-review.mjs"'), 'installed skill resolves absolute path');
    assert.match(yaml, /allow_implicit_invocation: false/);
  }
  // Custom CLI prompts
  for (const p of ['megalens-review.md', 'megalens-status.md', 'megalens-result.md']) {
    const md = readFileSync(path.join(codexHome, 'prompts', p), 'utf8');
    assert.match(md, /^---\ndescription:/);
    assert.match(md, /\$ARGUMENTS/);
    assert.ok(!md.includes('"codex/scripts/codex-review.mjs"'));
  }
  // Plugin bundle + marketplace
  const mp = JSON.parse(readFileSync(path.join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(mp.plugins.length, 1);
  assert.equal(mp.plugins[0].name, 'megalens');
  assert.equal(mp.plugins[0].source.path, './.codex/plugins/megalens');
  assert.ok(existsSync(path.join(home, '.codex', 'plugins', 'megalens', 'plugin.json')));
  assert.ok(existsSync(path.join(home, '.codex', 'plugins', 'megalens', 'mcp.json')));

  // No secret/token literal anywhere
  for (const f of walk(home)) {
    const txt = readFileSync(f, 'utf8');
    assert.ok(!/mlk_|ml_tok_|sk-[A-Za-z0-9]{10}/.test(txt), `unexpected token in ${f}`);
  }

  // Idempotent second run: zero updates, zero backups
  const r2 = installCodex({ scope: 'global', home, codexHome }, { flags: { codexPlugin: true } });
  assert.equal(r2.code, 0);
  assert.ok(r2.report.every((l) => !/^(created|updated)/.test(l)), r2.report.join('\n'));
  assert.equal(existsSync(path.join(home, '.megalens', 'backups')), false);
});

test('install-codex --with-oauth-mcp: merges into config.toml with backup, preserves existing npx megalens-mcp setup codex entry', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mlcodex-mcp-'));
  const codexHome = path.join(home, '.codex');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(codexHome, { recursive: true });

  // Case A: existing config without megalens -> appends managed block, backs up original (0600)
  const cfgPath = path.join(codexHome, 'config.toml');
  const orig = '# user settings\r\nmodel = "gpt-6.2-sol"\r\n\r\n[mcp_servers.other]\r\ncommand = "other"\r\n';
  writeFileSync(cfgPath, orig);
  const r1 = installCodex({ scope: 'global', home, codexHome, withOauthMcp: true }, { flags: { codexPlugin: true } });
  assert.equal(r1.code, 0);
  const updated = readFileSync(cfgPath, 'utf8');
  assert.ok(updated.startsWith('# user settings\r\nmodel = "gpt-6.2-sol"\r\n'));
  assert.match(updated, /\[mcp_servers\.megalens\]/);
  assert.match(updated, /https:\/\/megalens\.ai\/api\/mcp\?ide=codex/);
  assert.ok(checkToml(updated));
  assert.ok(!/(^|[^\r])\n/.test(updated), 'keeps CRLF line endings');
  const baks = walk(path.join(home, '.megalens', 'backups'));
  assert.equal(baks.length, 1);
  assert.equal(statSync(baks[0]).mode & 0o777, 0o600);
  assert.equal(readFileSync(baks[0], 'utf8'), orig);

  // Case B: existing [mcp_servers.megalens] from `npx megalens-mcp setup codex` -> never clobbered
  const home2 = mkdtempSync(path.join(tmpdir(), 'mlcodex-mcp2-'));
  const codexHome2 = path.join(home2, '.codex');
  t.after(() => rmSync(home2, { recursive: true, force: true }));
  mkdirSync(codexHome2, { recursive: true });
  const existingSetup = '[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers = { "Authorization" = "Bearer ml_tok_existing" }\n';
  writeFileSync(path.join(codexHome2, 'config.toml'), existingSetup, { mode: 0o600 });
  const r2 = installCodex({ scope: 'global', home: home2, codexHome: codexHome2, withOauthMcp: true }, { flags: { codexPlugin: true } });
  assert.equal(r2.code, 0);
  assert.equal(readFileSync(path.join(codexHome2, 'config.toml'), 'utf8'), existingSetup);
  assert.ok(r2.report.some((l) => /skipped.*already defines mcp_servers\.megalens/.test(l)));
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

// ---- 4. Static validation of codex/ manifests, skills, prompts, README ----

test('codex/ manifests, config example, skills, prompts and README follow official Codex specs', () => {
  const plugin = JSON.parse(readFileSync(path.join(CODEX_DIR, 'plugin.json'), 'utf8'));
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(plugin.name, 'megalens');
  assert.equal(plugin.extensions['com.openai'].interface.displayName, 'MegaLens');
  assert.equal(plugin.extensions['com.openai'].interface.privacyPolicyURL, 'https://megalens.ai/privacy');

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

  const exampleToml = readFileSync(path.join(CODEX_DIR, 'config.desktop.example.toml'), 'utf8');
  assert.ok(checkToml(exampleToml));
  assert.match(exampleToml, /\[mcp_servers\.megalens\]/);
  assert.match(exampleToml, /npx megalens-mcp setup codex/);
  assert.ok(!/ml_tok_|mlk_|sk-/.test(exampleToml));

  for (const s of ['megalens-review', 'megalens-status', 'megalens-result']) {
    const skillMd = readFileSync(path.join(CODEX_DIR, 'skills', s, 'SKILL.md'), 'utf8');
    const yaml = readFileSync(path.join(CODEX_DIR, 'skills', s, 'agents', 'openai.yaml'), 'utf8');
    assert.match(skillMd, new RegExp(`^---\\nname: ${s}\\ndescription:`));
    assert.match(yaml, /allow_implicit_invocation: false/);
  }

  const reviewPrompt = readFileSync(path.join(CODEX_DIR, 'prompts', 'megalens-review.md'), 'utf8');
  assert.match(reviewPrompt, /argument-hint: \[deep\]/);
  assert.match(reviewPrompt, /\$ARGUMENTS/);
  assert.match(reviewPrompt, /\$\$megalens-result/); // literal $ escaped per Codex custom prompts spec
  assert.match(reviewPrompt, /never start a second review command/i);
  assert.match(reviewPrompt, /Never push on your own/);

  const readme = readFileSync(path.join(CODEX_DIR, 'README.md'), 'utf8');
  assert.match(readme, /npx megalens-mcp setup codex/);
  assert.match(readme, /install-codex\.mjs/);
  assert.match(readme, /APP_PATH_ENABLED = false/);
  assert.match(readme, /CODEX_PLUGIN_ENABLED = false/);
});
